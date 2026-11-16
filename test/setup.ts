// Runs before every test file.
//
// The csst.at fallback sends real requests (wreq-js, with a Chrome fingerprint). No test may reach the real csst.at:
// a test that gets to the fallback without a stand-in would hit the network, and csst.at is somebody's website. With
// the origin pointing at a closed local port, such a test gets a fast "site-unreachable" status instead. Tests of the
// fallback itself set CS2CLEAN_CSST_ORIGIN to a local server of their own.
process.env.CS2CLEAN_CSST_ORIGIN = "http://127.0.0.1:1";
