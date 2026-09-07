import { assertStrictResults } from './strict-policy.mjs';
export default class StrictReporter {
  onBegin(_config, suite) { this.suite = suite; }
  onEnd() {
    try {
      assertStrictResults(this.suite.allTests());
      console.log(`Strict acceptance: ${this.suite.allTests().length} journeys passed, zero skipped.`);
    } catch (error) {
      console.error(error.message);
      return { status: 'failed' };
    }
  }
}
