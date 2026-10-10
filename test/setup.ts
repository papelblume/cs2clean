// Runs before every test file.
//
// The csst.at fallback starts a sidecar (a child Node running Ulixee Hero, and on first use a Chrome download).
// No test may start the real one: a test that reaches the fallback without a stand-in would spend seconds
// spawning Node and could begin a Chrome download of a few hundred MB. With the sidecar folder pointing nowhere, such a test gets
// a fast "no-runtime" status instead. Tests of the fallback itself set CS2CLEAN_HERO_DIR to a stub of their own.
process.env.CS2CLEAN_HERO_DIR = "/nonexistent/cs2clean-hero-runtime-for-tests";
delete process.env.CS2CLEAN_NODE22;
