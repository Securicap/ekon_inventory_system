import { loadEnvFile } from '../src/config/env.js';

// Tests read DATABASE_URL from the repository's .env, exactly as the
// application does, so a passing test suite proves the developer's environment
// is actually configured. CI sets the variable directly and has no .env.
loadEnvFile();
