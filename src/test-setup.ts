import '@testing-library/jest-dom'
import { beforeEach } from 'vitest'

// jsdom does not implement scrollIntoView; guard for node environment (lib tests)
if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}

// Node's --localstorage-file storage is FUNCTIONAL and process-wide on the CI
// runner but a methodless stub on local macs — so a component that persists UI
// state leaks it into the next test ONLY on CI (the StarMapPeople #806→#825
// local-green/CI-red saga). Guarded optional-calls: no-op where the methods
// don't exist, a clean slate per test where they do. Setup-file hooks run
// before suite-level beforeEach hooks, so suites that seed storage still work.
beforeEach(() => {
  globalThis.localStorage?.clear?.()
  globalThis.sessionStorage?.clear?.()
})
