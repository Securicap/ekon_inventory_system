# OCI zero-cost production candidate

The canonical runbook for running Ekon on a single Oracle Cloud Infrastructure
Always Free VM: Caddy in front, the application behind it, PostgreSQL on an
attached block volume, and a nightly backup that leaves the machine.

This is a **production candidate**, not production. Nothing in this document
makes it live. It becomes production when every box in the
[acceptance checklist](#production-candidate-acceptance-checklist) is ticked —
and not before, because until the backup and the restore drill have both been
seen to work, the business's inventory would exist in exactly one place.

Staging stays where it is: Northflank + Supabase, documented in
[northflank-supabase.md](northflank-supabase.md), unchanged by any of this. A
release is proven there first.

## What runs, and what it costs

```text
Internet
   │  HTTPS 443 / HTTP 80
   ▼
Caddy ─────────── ekon_front ──────────┐
   (the only container with a          │
    published port)                    ▼
                                     Ekon app  :8080
                                       │
                                  ekon_back (internal, no route out)
                                       ▼
                                   PostgreSQL 16  :5432
                                       │
                              /srv/ekon/postgres on an
                              attached OCI Block Volume
                                       │
                                   nightly pg_dump
                                       ▼
                            OCI Object Storage bucket
                                       │
                              weekly manual download
                                       ▼
                         a device outside Oracle entirely
```

Every component is inside the OCI Always Free allowance. The bill is zero, and
what is bought with that is _not_ an availability guarantee — see
[Idle reclamation](#idle-reclamation-and-what-always-free-does-not-promise).

## The rule this deployment is built around

Staging spent weeks reporting

```json
{ "version": "staging" }
```

while serving a commit nobody could identify. There was no way to answer "what
is running?" without guessing.

**`APP_VERSION` is derived from the deployed commit, by the deploy script, and
the deployment fails if the running application reports anything else.** No
operator types it. It is not a branch, an environment name, or a tag — it is the
full 40-character SHA, read from the Git tree that was built.

`scripts/verify.sh` is what enforces it. A deploy that ends any other way is not
a deploy.

---

# Part 1 — Provisioning

## 1.1 The VM

An **Ubuntu 24.04 LTS** instance on an Always Free shape.

|             |                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Shape       | `VM.Standard.A1.Flex` (Ampere), 2 OCPU / 12 GB is comfortable and within the Always Free allowance |
| Alternative | `VM.Standard.E2.1.Micro` (AMD) if Ampere capacity is unavailable                                   |
| Image       | Canonical Ubuntu 24.04                                                                             |
| Boot volume | Default (47 GB) is plenty; the database lives elsewhere                                            |

Sizing is deliberately modest. Ekon is a Fastify process and a PostgreSQL for
one shop; it does not need compute.

> **Capacity is not guaranteed.** Always Free Ampere capacity is frequently
> exhausted in popular regions and availability domains, and an "out of host
> capacity" error is a normal answer. Retry, try another availability domain, or
> use the E2.1.Micro shape. Nothing in this document promises the shape will be
> available when you want it.

Choose a region close to Haiti — `us-ashburn-1` is the usual choice.

## 1.2 Block volume for the database

The boot volume would work, but a separate volume is what lets the database
survive the VM: it can be detached from a dead instance and attached to a new
one with the data intact.

Create a **50 GB** block volume in the same availability domain, attach it to
the instance as **paravirtualized**, then on the VM:

```bash
lsblk    # identify the new device — typically /dev/sdb, with no partitions
```

> ### ⚠ FIRST-TIME INITIALIZATION ONLY — NEVER RUN AGAINST AN EXISTING PRODUCTION VOLUME
>
> The next command **destroys everything on the device**. It is correct exactly
> once, on a volume that has just been created and has never held data.
>
> During a recovery, when the volume being attached is the _surviving_ one from
> a lost VM, **skip this and go straight to mounting**. Formatting it would
> destroy the only copy of the inventory that is not in Object Storage.
>
> Before running it, confirm the device is empty:
>
> ```bash
> sudo blkid /dev/sdb        # no output = no filesystem = safe to format
> sudo lsblk -f /dev/sdb     # FSTYPE column must be blank
> ```
>
> If either shows a filesystem, **stop**. That volume has data on it.
>
> ```bash
> sudo mkfs.ext4 /dev/sdb    # ⚠ DESTROYS ALL DATA ON /dev/sdb
> ```

Mount it, on first use and on recovery alike:

```bash
sudo mkdir -p /srv/ekon
sudo mount /dev/sdb /srv/ekon
```

Make it survive a reboot. Use the UUID, never `/dev/sdb` — device names are not
stable across attachments:

```bash
sudo blkid /dev/sdb            # note UUID="...."
sudo cp /etc/fstab /etc/fstab.backup
echo 'UUID=<the-uuid>  /srv/ekon  ext4  defaults,_netdev,nofail  0  2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount -a                  # must succeed with no output
```

`nofail` matters: without it, a VM whose volume failed to attach does not boot
at all, and you cannot SSH in to fix it. `_netdev` tells systemd this is a
network-attached device and to wait for it.

Create the directories and hand PostgreSQL's data directory to the uid the
container runs as (999 in the official image):

```bash
sudo mkdir -p /srv/ekon/{postgres,caddy/data,caddy/config,backups}
sudo chown -R 999:999 /srv/ekon/postgres
sudo chmod 700 /srv/ekon/postgres
sudo chown -R "$USER":"$USER" /srv/ekon/backups
sudo chmod 750 /srv/ekon/backups
```

> `ls /srv/ekon/postgres` will answer `Permission denied` for your operator
> account afterwards. That is correct — the directory belongs to PostgreSQL.

**Verify the volume is mounted before PostgreSQL ever starts.** If it is not,
Docker silently creates `/srv/ekon/postgres` on the _boot_ volume and PostgreSQL
initializes a database there — which then disappears the moment the real volume
is mounted over it.

```bash
findmnt /srv/ekon || { echo 'NOT MOUNTED — do not start the stack'; }
```

Make that a habit before every `deploy.sh` on a freshly booted VM.

## 1.3 Network: OCI security list and host firewall

Two layers, because either one alone is a single point of failure.

**OCI ingress rules** (VCN → security list, or a network security group):

| Protocol | Port | Source                                  | Why                                      |
| -------- | ---- | --------------------------------------- | ---------------------------------------- |
| TCP      | 80   | `0.0.0.0/0`                             | ACME challenge and the redirect to HTTPS |
| TCP      | 443  | `0.0.0.0/0`                             | The application                          |
| TCP      | 22   | your own address, e.g. `203.0.113.4/32` | SSH                                      |

Restrict 22 to a known address wherever the operator has a stable one. If they
do not, `0.0.0.0/0` with key-only authentication is the fallback — not ideal,
and the reason password login is disabled below.

**Never open:**

| Port     | Why not                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5432** | The database. It is on an internal Docker network with no published port; an ingress rule for it would be inviting something that is not otherwise reachable.                                                              |
| **8080** | The application's plain-HTTP origin. Publishing it would put an unencrypted copy of Ekon beside the one Caddy protects — session cookies are `Secure`, so it would not even work, but it would still be an exposed origin. |

**Host firewall.** Ubuntu images on OCI ship iptables rules; UFW is clearer to
maintain. Do not rely on "Docker does not publish the port" alone:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

> Docker's iptables rules bypass UFW's `INPUT` chain for _published_ ports. This
> deployment publishes only 80 and 443, which UFW allows anyway — so the two
> agree. The rule to remember: adding a `ports:` entry to `compose.yaml` exposes
> it to the internet regardless of UFW. That is why the application and the
> database use `expose:` and nothing else.

## 1.4 SSH and host hardening

Proportionate, and no more:

```bash
# Key authentication only.
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

Confirm you can still open a **second** session before closing the first.

The operator account is the image's `ubuntu` user (or one created like it): a
non-root account with `sudo`. Ekon is never run as root, and the containers run
as their images' own users.

Unattended security updates:

```bash
sudo apt update && sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Docker is updated with the rest of the system:

```bash
sudo apt update && sudo apt upgrade -y      # monthly, or when a CVE says sooner
docker compose -f /opt/ekon/deploy/oci/compose.yaml ps   # confirm it came back
```

## 1.5 Docker, and the repository

```bash
sudo apt update
sudo apt install -y ca-certificates curl git python3
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"      # log out and back in for this to take effect
```

`python3` and `curl` are what `verify.sh` uses to read the health endpoint. Both
are on Ubuntu LTS already; they are installed above for the case where they are
not. There is deliberately no `jq` dependency.

```bash
sudo mkdir -p /opt/ekon && sudo chown "$USER":"$USER" /opt/ekon
git clone https://github.com/Securicap/ekon_inventory_system.git /opt/ekon
cd /opt/ekon/deploy/oci
```

## 1.6 DNS

Point an `A` record for the chosen hostname at the VM's public IP, and wait for
it to resolve **before** the first deploy — Caddy's certificate request will
fail otherwise, and repeated failures hit Let's Encrypt rate limits.

```bash
dig +short inventory.example.com     # must return the VM's public IP
```

## 1.7 Configuration

```bash
cd /opt/ekon/deploy/oci
cp production.env.example production.env
chmod 600 production.env
openssl rand -hex 32                 # paste as POSTGRES_PASSWORD
$EDITOR production.env
```

`production.env` is gitignored and must never be committed. Fill in
`EKON_DOMAIN`, `EKON_ACME_EMAIL`, `POSTGRES_PASSWORD`, and `OCI_BACKUP_BUCKET`.

`APP_VERSION`, `EXPECTED_SCHEMA_VERSION` and `DATABASE_URL` are **not** in it and
must not be added: the first two are derived by `deploy.sh` from the commit, and
the third is built by `compose.yaml` from the three `POSTGRES_*` values so the
password exists in exactly one place.

> The password must be URL-safe (`A-Z a-z 0-9 . _ ~ -`), because it is
> substituted into `DATABASE_URL`. `openssl rand -hex 32` always is. `deploy.sh`
> refuses anything else rather than letting the application fail to connect for
> a reason nobody would guess.

---

# Part 2 — Deploying

## 2.1 First deploy

```bash
cd /opt/ekon/deploy/oci
findmnt /srv/ekon                       # the volume must be mounted
./scripts/deploy.sh main                # or an exact SHA
```

`deploy.sh` does all of this, and stops at the first thing that is wrong:

1. refuses without a `production.env` at mode `600`;
2. refuses a dirty Git working tree;
3. fetches, resolves the ref to a **full immutable SHA**, checks it out detached;
4. `APP_VERSION=$(git rev-parse HEAD)` — read back from the tree, and refused
   unless it is 40 hex characters;
5. derives `EXPECTED_SCHEMA_VERSION` from the highest `NNNN_*.sql` in
   `backend/migrations` _of that commit_, and refuses if it cannot;
6. refuses a placeholder or URL-unsafe database password;
7. builds `ekon-app:<sha>` from the repository's root `Dockerfile`;
8. starts PostgreSQL and waits for `pg_isready`;
9. runs `npm run migrate` **from the image just built**, then `migrate:status`;
10. aborts on any migration failure, leaving the previous app container serving;
11. starts/recreates the app and Caddy;
12. runs `verify.sh` against the public HTTPS URL and **fails the deploy** unless
    `status=ok`, `database=up`, `schemaVersion=<derived>`, and
    `version=<the SHA it just deployed>`.

The migration command is the application's own. This deployment contains no
migration logic, no SQL, and no business rules — it is glue.

## 2.2 Bootstrap the first owner — exactly once

A migrated database has no accounts and nobody who could be authorized to create
one. Use the existing command; do not invent another mechanism, and do not put
the password in `production.env`.

```bash
cd /opt/ekon/deploy/oci
read -rs EKON_OWNER_PASSWORD && export EKON_OWNER_PASSWORD
docker compose --env-file production.env -f compose.yaml run --rm --no-deps \
  -e EKON_OWNER_USERNAME='<username>' \
  -e EKON_OWNER_DISPLAY_NAME='<full name>' \
  -e EKON_OWNER_PASSWORD \
  app npm run identity:create-owner
unset EKON_OWNER_PASSWORD
```

`read -rs` keeps the password off the terminal and out of shell history. The
command refuses if an active owner already exists, so re-running it is safe and
cannot create a second account. Everyone after this one is created inside the
application.

## 2.3 Subsequent releases

Never deploy a moving target. Record the SHA.

```text
1. merge to main
2. CI green
3. release proven on Northflank staging
4. choose the exact commit SHA
5. ./scripts/deploy.sh <sha>
      → derives APP_VERSION and EXPECTED_SCHEMA_VERSION from that commit
      → builds, migrates, starts
      → verifies /api/health reports that SHA
6. record the SHA in the operations log
```

`./scripts/deploy.sh main` is acceptable when `main` is fetched fresh in the same
command — the script resolves it to a SHA immediately and reports it — but the
SHA is what goes in the log, because `main` will mean something else tomorrow.

Rollback: redeploy the previous SHA. It carries its own schema pin, so a rollback
across a migration boundary will **refuse to start** rather than run old code
against a newer schema. That refusal is deliberate and is the moment to decide
consciously what to do. Migrations are forward-only and there is no `down`; if
one must be undone, write a new forward migration. **No database rollback is
automated here, and none should be.**

---

# Part 3 — Backups

Backups are a launch gate, not a follow-up task. The VM is disposable; the
inventory is not.

## 3.1 Object Storage and instance principals

Create a **private** bucket, e.g. `ekon-backups`, in the same region. OCI
encrypts objects at rest with Oracle-managed keys by default.

The VM authenticates with an **instance principal** — its own identity, proven
by the instance metadata service. There is no API key, no private key, and no
tenancy OCID on the machine or in this repository.

```text
the instance  →  a dynamic group that matches it  →  a policy scoped to one bucket
```

1. **Dynamic group** `ekon-production-vms`, matching only this instance:

   ```text
   ANY {instance.id = 'ocid1.instance.oc1..<placeholder>'}
   ```

2. **Policy**, in the compartment holding the bucket — narrow on purpose:

   ```text
   Allow dynamic-group ekon-production-vms to read buckets in compartment <compartment-name>
   Allow dynamic-group ekon-production-vms to manage objects in compartment <compartment-name>
        where target.bucket.name = 'ekon-backups'
   ```

   `manage objects` on one named bucket. Not `manage all-resources`, not
   tenancy-wide.

3. Install the CLI and confirm the identity works:

   ```bash
   bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
   oci os ns get --auth instance_principal          # prints the namespace
   ```

Real OCIDs, the namespace, and the dynamic-group ID are **never committed**. The
placeholders above are placeholders.

## 3.2 The backup script

```bash
./scripts/backup.sh
```

1. `pg_dump -Fc` **inside the postgres container**, so the dump client is always
   the exact version of the server that wrote the data;
2. written to `.<name>.partial` first — a truncated dump can never be mistaken
   for a finished one;
3. renamed to its final name only after `pg_dump` succeeds and the file is
   confirmed to start with the `PGDMP` magic;
4. SHA-256 written beside it;
5. checksum then dump uploaded to Object Storage with `--no-overwrite`;
6. **any upload failure aborts loudly and prunes nothing** — the last good local
   copy is never deleted because the network was down;
7. local retention (`BACKUP_LOCAL_KEEP`, default 7) applied **only after** a
   successful upload.

`EKON_BACKUP_SKIP_UPLOAD=1 ./scripts/backup.sh` produces the dump and checksum
and stops. That is for rehearsal only: a backup that never left the VM does not
survive the VM.

## 3.3 Nightly schedule

A systemd timer, not cron: it survives reboots, records the exit status, and
`systemctl status` says what happened.

`/etc/systemd/system/ekon-backup.service`:

```ini
[Unit]
Description=Ekon nightly database backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/ekon/deploy/oci
ExecStart=/opt/ekon/deploy/oci/scripts/backup.sh
```

`/etc/systemd/system/ekon-backup.timer`:

```ini
[Unit]
Description=Run the Ekon backup nightly

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ekon-backup.timer
sudo systemctl list-timers ekon-backup.timer
sudo systemctl start ekon-backup.service     # run one now
journalctl -u ekon-backup.service -n 50      # read what it did
```

`Persistent=true` runs a missed backup after a reboot rather than skipping a
night.

## 3.4 Retention

| Where                    | How long                        | Enforced by                            |
| ------------------------ | ------------------------------- | -------------------------------------- |
| VM (`/srv/ekon/backups`) | last **7** successful           | `backup.sh`, after a successful upload |
| Object Storage           | about **30** days               | An Object Storage **lifecycle policy** |
| Outside Oracle           | as long as the owner keeps them | The owner                              |

Remote retention is a lifecycle rule configured once in the console — a rule that
deletes objects older than 30 days in `ekon-backups`. **The script deletes
nothing remotely.** A scripted delete loop against the only off-VM copy of the
business's records is the kind of clever that erases a shop's history at 3am.

## 3.5 The independent copy — weekly, by a person

> **A backup inside the same Oracle account is not the independent copy.** An
> account closure, a billing problem, or a mistaken credential takes the VM and
> the bucket together.

Weekly, from the owner's own computer — never automated _from_ production, which
would mean production holding a credential to somebody's laptop:

```bash
# On the owner's machine, with their own OCI credentials
oci os object list --bucket-name ekon-backups --query 'data[-1:].name' --raw-output
oci os object get --bucket-name ekon-backups --name ekon-<stamp>.dump        --file ekon-<stamp>.dump
oci os object get --bucket-name ekon-backups --name ekon-<stamp>.dump.sha256 --file ekon-<stamp>.dump.sha256

sha256sum -c ekon-<stamp>.dump.sha256      # must print: OK
```

Keep it somewhere that is not Oracle: the laptop plus an external drive. A copy
whose checksum has not been verified is not yet a copy.

---

# Part 4 — Restore

## 4.1 The drill — safe, and run on a schedule

```bash
./scripts/restore-drill.sh /srv/ekon/backups/ekon-<stamp>.dump
```

It **cannot** touch production. It verifies the checksum, refuses a corrupt or
non-PostgreSQL archive, starts its own `postgres:16-alpine` container on
`--network none` with its own credentials and its own throwaway storage,
`pg_restore`s into it, then checks:

- `pg_restore` completed with `--exit-on-error`;
- `schema_migrations` has a head version, and whether it matches this checkout;
- every core table exists — users, sessions, role_capabilities, products,
  product_variants, variant_attributes, inventory_locations, inventory_movements,
  inventory_balances, operations, schema_migrations;
- the restored database has at least one **active owner**, or nobody could sign
  in to it;
- every `inventory_balances` row has movements behind it — the ledger's own
  invariant, checked against the restored copy;
- read-only counts of users, products, movements and balance rows.

It prints **PASS** or **FAIL** and removes the disposable container either way.

Run it after the first backup, and monthly. **An untested backup is not a
backup.**

## 4.2 There is deliberately no `restore-production.sh`

Restoring the business's live records over the top of whatever is there is a
decision, not a script. The procedure below requires an operator to type each
step with their eyes open.

## 4.3 Recovery: the application or a container is lost

Persistent storage intact — the ordinary case.

```bash
cd /opt/ekon/deploy/oci
findmnt /srv/ekon                    # confirm the volume is mounted FIRST
./scripts/deploy.sh <known-good-sha>
```

The database was never touched. `deploy.sh` verifies the result as always.

## 4.4 Recovery: the VM is gone

Oracle reclaimed it, the region lost it, or it was deleted. This procedure does
**not** require the old VM.

**Path A — the block volume survived.** Preferred: no data loss at all.

1. Provision a replacement VM (Part 1.1) in the same availability domain.
2. Install Docker, git, python3, curl (Part 1.5).
3. Recreate the OCI ingress rules and UFW (Part 1.3) and SSH hardening (1.4).
4. **Attach the surviving block volume.** Then:

   ```bash
   lsblk
   sudo blkid /dev/sdb      # shows an existing ext4 UUID — data is there
   ```

   > ⚠ **DO NOT run `mkfs`.** `blkid` printing a UUID means this volume holds the
   > database. Formatting it destroys the only copy that is not in Object
   > Storage. Mount it; do not initialize it.

   ```bash
   sudo mkdir -p /srv/ekon
   sudo mount /dev/sdb /srv/ekon
   findmnt /srv/ekon
   ```

   Add the fstab entry with the volume's **existing** UUID (Part 1.2).

5. Clone the repository, restore `production.env` from the owner's records, and
   `chmod 600` it.
6. Point DNS at the new public IP; wait for it to resolve.
7. `./scripts/deploy.sh <known-good-sha>`.
8. Verify `/api/health` reports that SHA.
9. Sign in and confirm the latest known inventory is present.
10. Post one small controlled movement — receive 1, check the balance, remove 1 —
    before anyone resumes normal use.

**Path B — the volume is gone too.** Restore from Object Storage; everything
since the last nightly backup is lost.

1–3. As Path A.

4. Create a **new** block volume and attach it. This one is genuinely empty, so
   the first-time initialization in Part 1.2 applies — after confirming with
   `sudo blkid /dev/sdb` that it prints nothing.
5. Create the directories and ownership (Part 1.2).
6. Clone the repository, restore `production.env`, `chmod 600`.
7. Fetch the latest backup — from the owner's independent copy, or from Object
   Storage with their own credentials — and **verify it**:

   ```bash
   sha256sum -c ekon-<stamp>.dump.sha256      # must print OK
   ```

8. **Drill it before trusting it:**

   ```bash
   ./scripts/restore-drill.sh /srv/ekon/backups/ekon-<stamp>.dump
   ```

9. Bring up an empty database and migrate to the release's schema:

   ```bash
   ./scripts/deploy.sh <known-good-sha>
   ```

   Health will be `ok` against an empty database. That is expected — the data
   comes next.

10. Restore into it. Deliberate, and typed by a person:

    ```bash
    cd /opt/ekon/deploy/oci
    docker compose --env-file production.env -f compose.yaml stop app

    docker compose --env-file production.env -f compose.yaml exec -T postgres \
      psql -U "$POSTGRES_USER" -d postgres \
      -c 'DROP DATABASE IF EXISTS ekon;' -c 'CREATE DATABASE ekon OWNER ekon;'

    docker compose --env-file production.env -f compose.yaml exec -T postgres \
      pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
                 --no-owner --no-privileges --exit-on-error \
      < /srv/ekon/backups/ekon-<stamp>.dump

    docker compose --env-file production.env -f compose.yaml start app
    ./scripts/verify.sh
    ```

    The restored dump carries its own `schema_migrations`. If the backup predates
    the release being deployed, the application will refuse to start on the
    schema pin — run `deploy.sh` again, which migrates the restored database
    forward before starting the app.

11. Verify `/api/health`, then sign in and check the most recent inventory the
    business remembers.
12. Post one small controlled movement before resuming normal use.

**Tell the shop what was lost.** Anything entered after the last successful
backup is not there, and somebody has to re-enter it from paper.

---

# Part 5 — Operating

## 5.1 Idle reclamation, and what Always Free does not promise

Oracle may reclaim Always Free compute that it considers idle, and Always Free
carries **no SLA**. A VM can disappear with little notice.

**This deployment does not fight that.** There is no keepalive CPU burner, no
synthetic traffic, no scheduled request whose only purpose is to consume
bandwidth, and no mining loop. Those defeat the spirit of the free tier, may
breach the terms, and would cost the business its account — the opposite of
protecting its records.

The mitigation is **recoverability**, not availability:

- the database is on a block volume that outlives the instance;
- a nightly dump leaves the machine entirely;
- a weekly copy leaves Oracle entirely;
- the VM-loss procedure above needs nothing from the old VM.

If the shop later needs an availability guarantee, that is a paid plan and a
different decision. Today the budget is $0 and the accepted risk is downtime,
never data loss.

## 5.2 Monitoring

No monitoring dependency is added to the application, and no vendor is
mandatory. Configure **any reputable external HTTPS monitor** against:

```text
https://<domain>/api/health
```

- alert when the status is **not 200** (the endpoint answers `503` when the
  database is down, which is exactly the case worth waking up for);
- every 5 minutes is plenty;
- it must notify **a real person** — email or SMS to the owner;
- a free tier is fine.

The health body is enough to triage without SSH: `database` says whether
PostgreSQL is reachable, `schemaVersion` whether the schema is what this build
expects, and `version` exactly which commit is running.

## 5.3 Logs

The application writes structured JSON to stdout; Docker keeps it. Nothing is
shipped anywhere, and no logging SaaS is involved.

```bash
cd /opt/ekon/deploy/oci
docker compose --env-file production.env -f compose.yaml logs -f app
docker compose --env-file production.env -f compose.yaml logs --since 1h app
docker compose --env-file production.env -f compose.yaml logs --since 2026-08-10T14:00:00 app
docker compose --env-file production.env -f compose.yaml logs caddy | tail -50
```

Every response carries `x-request-id`, and every API error repeats it in the
body. A person reporting a failure can read the code off their screen; find it
in the logs as `reqId`. Cookies, authorization headers and password fields are
removed before any line is written.

Cap the disk a busy month could take:

```bash
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
sudo systemctl restart docker
```

## 5.4 Routine

| When               | What                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| Nightly, automatic | `ekon-backup.timer` runs `backup.sh`                                                  |
| Weekly             | Download the latest backup + checksum off Oracle; `sha256sum -c`                      |
| Monthly            | `restore-drill.sh` against the newest backup                                          |
| Monthly            | `sudo apt update && sudo apt upgrade -y`, then confirm the stack came back            |
| Each release       | `deploy.sh <sha>`; record the SHA                                                     |
| Occasionally       | `journalctl -u ekon-backup.service --since '7 days ago'` — has every night succeeded? |

---

# Production-candidate acceptance checklist

**Real inventory must not be entered until every box is ticked.** Each is
something to observe, not something to assume.

```text
[ ] known release SHA deployed
[ ] APP_VERSION equals the deployed SHA        (verify.sh passes)
[ ] EXPECTED_SCHEMA_VERSION derived correctly  (deploy.sh printed it; health agrees)
[ ] PostgreSQL persistent volume mounted       (findmnt /srv/ekon)
[ ] PostgreSQL survives container recreation   (down && up, data still there)
[ ] 5432 not publicly reachable                (nc -zv <public-ip> 5432 from elsewhere fails)
[ ] 8080 not publicly reachable                (nc -zv <public-ip> 8080 from elsewhere fails)
[ ] only Caddy exposes application traffic     (docker compose ps shows ports on caddy alone)
[ ] valid HTTPS                                (browser padlock; no warning)
[ ] Secure session cookie works                (devtools: Secure + HttpOnly + SameSite=Lax)
[ ] /api/health healthy                        (status ok, database up)
[ ] owner bootstrapped                         (sign in as the owner)
[ ] nightly backup succeeds automatically      (systemctl list-timers; journalctl shows a success)
[ ] Object Storage backup exists               (oci os object list)
[ ] checksum validates                         (sha256sum -c)
[ ] disposable restore drill passes            (restore-drill.sh prints PASS)
[ ] external monitoring configured             (alerts a real person on non-200)
[ ] independent backup copy obtained           (downloaded off Oracle and verified)
[ ] full Owner → Employee → Product → Receive → Inventory → Remove → Inventory → Sign Out
    invariant passes on the shop's own hardware
```

> **If backup or restore fails: DO NOT ENTER REAL INVENTORY.**
>
> A shop that starts recording stock against a system whose backups do not work
> is worse off than one still using paper — it has traded a ledger it can see for
> one it cannot recover.

The last line is the launch invariant from
[deployment.md](deployment.md#the-launch-invariant), performed on the hardware
the shop will actually use, through supported workflows only — no API call, no
SQL, no shell command anywhere in the sequence.

## What has and has not been exercised

**Verified locally**, by a full rehearsal on a developer machine, against the
real images and the real application:

- `compose.yaml` resolves, and only Caddy publishes ports;
- the image builds from the repository's root `Dockerfile`;
- `npm run migrate` from that image applies all eight migrations;
- the application boots and `/api/health` reports the exact commit SHA;
- `verify.sh` **passes** with the right SHA and **fails with exit 1** with the
  wrong one;
- the owner bootstrap creates the first account;
- a product, a receipt and a removal posted through the API produce the expected
  balance;
- the data survives `docker compose down` followed by `up`;
- `backup.sh` produces a valid custom-format dump plus checksum;
- `restore-drill.sh` restores it into a disposable database and prints **PASS**;
- the drill **refuses** a corrupted archive.

**Not exercised, because it needs a real OCI account:** the VM shape and its
availability, the block volume and `/etc/fstab`, OCI ingress rules, Caddy's ACME
certificate against a real domain, instance-principal authentication, the Object
Storage upload and its lifecycle policy, the systemd timer on the VM, and the
external monitor. Every one of those is a checklist line above, to be observed
on the machine.

Nothing in this document should be read as "OCI has been tested". It has not.
The tooling has.
