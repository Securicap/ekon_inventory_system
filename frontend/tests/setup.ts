import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  // No test may leak browser storage into the next one — and every
  // authentication test asserts that the application left both empty.
  window.localStorage.clear();
  window.sessionStorage.clear();
});
