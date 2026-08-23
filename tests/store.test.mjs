// The jobs directory as a resource: who may read it, what is carried over from
// the pre-upgrade layout, and what housekeeping is allowed to delete. All of it
// is a function of what is on disk, so these call the store directly instead of
// spawning the CLI to get at it.
import { test, beforeEach, afterEach, after } from "node:test";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HAVE_UID = process.getuid !== undefined;
const UID = HAVE_UID ? process.getuid() : null;
const DEFAULT_DIR_NAME = `kiro-plugin-cc-jobs-${UID}`;
const LEGACY_DIR_NAME = "kiro-plugin-cc-jobs";

let tmpDir;
let jobsDir;
let savedEnv;
const created = [];

beforeEach(() => {
  savedEnv = { jobs: process.env.KIRO_PLUGIN_JOBS_DIR, tmp: process.env.TMPDIR, ttl: process.env.KIRO_PLUGIN_JOB_TTL_MS };
  tmpDir = mkdtempSync(join(tmpdir(), "kiro-store-test-"));
  created.push(tmpDir);
  jobsDir = join(tmpDir, "jobs");
  process.env.KIRO_PLUGIN_JOBS_DIR = jobsDir;
});

afterEach(() => {
  for (const [key, value] of [["KIRO_PLUGIN_JOBS_DIR", savedEnv.jobs], ["TMPDIR", savedEnv.tmp], ["KIRO_PLUGIN_JOB_TTL_MS", savedEnv.ttl]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fresh module instance. migrateLegacyJobsDir runs at most once per process,
 * so every migration case needs its own copy of the module or it silently
 * becomes a no-op.
 */
let seq = 0;
function freshStore() {
  seq += 1;
  return import(`../plugins/kiro-cli/scripts/lib/jobs.js?instance=${seq}`);
}

/** Points the default-path logic at a directory this test owns. */
function useDefaultPathIn(home) {
  mkdirSync(home, { recursive: true });
  delete process.env.KIRO_PLUGIN_JOBS_DIR;
  process.env.TMPDIR = home;
}

const NOW = () => new Date().toISOString();
const AT = (ms) => new Date(ms).toISOString();

/** A terminal record plus its transcript, as the runner would leave them. */
function plant(dir, id, { bytes = 0, finishedAt = NOW(), status = "completed", recordSize = true, text } = {}) {
  mkdirSync(dir, { recursive: true });
  const body = text ?? "x".repeat(bytes);
  const record = { id, kind: "review", status, startedAt: finishedAt, finishedAt };
  if (body.length > 0 && recordSize) record.resultBytes = Buffer.byteLength(body);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record));
  if (body.length > 0) writeFileSync(join(dir, `${id}.out`), body);
}

function names(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function age(dir, name, ms) {
  const when = new Date(Date.now() - ms);
  utimesSync(join(dir, name), when, when);
}

// --- who may read the store ---

test("the default jobs directory is per-user, 0700, and tightened if it is not", async (t) => {
  if (!HAVE_UID) return t.skip("no uid on this platform");
  const home = join(tmpDir, "home");
  useDefaultPathIn(home);
  const store = await freshStore();
  // Records hold Kiro's full output, which for a private repository is source
  // code -- never the shared, world-readable directory mkdir would produce.
  assert.equal(store.ensureJobsDir(), join(home, DEFAULT_DIR_NAME));
  assert.equal(statSync(join(home, DEFAULT_DIR_NAME)).mode & 0o777, 0o700);

  // And an existing one from an older version gets the same treatment.
  const loose = join(tmpDir, "loosehome");
  mkdirSync(join(loose, DEFAULT_DIR_NAME), { recursive: true, mode: 0o777 });
  useDefaultPathIn(loose);
  const store2 = await freshStore();
  store2.ensureJobsDir();
  assert.equal(statSync(join(loose, DEFAULT_DIR_NAME)).mode & 0o077, 0);
});

test("a directory the operator chose keeps the permissions they gave it", async (t) => {
  if (!HAVE_UID) return t.skip("no uid on this platform");
  // They have already made that call; chmod-ing it out from under them would be
  // worse than honouring it. Records inside are 0600 either way.
  mkdirSync(jobsDir, { recursive: true, mode: 0o755 });
  const store = await freshStore();
  store.ensureJobsDir();
  assert.equal(statSync(jobsDir).mode & 0o777, 0o755);
  store.saveJob({ id: "kiro-perm0001-aa", kind: "review", status: "running", startedAt: NOW() });
  store.saveJobResult("kiro-perm0001-aa", "private source code");
  assert.equal(statSync(join(jobsDir, "kiro-perm0001-aa.json")).mode & 0o077, 0);
  assert.equal(statSync(join(jobsDir, "kiro-perm0001-aa.out")).mode & 0o077, 0);
});

test("a symlinked default directory is refused, by listing and by id alike", async (t) => {
  if (!HAVE_UID) return t.skip("no uid on this platform");
  const home = join(tmpDir, "symhome");
  const planted = join(tmpDir, "elsewhere");
  mkdirSync(planted, { mode: 0o700 });
  writeFileSync(join(planted, "kiro-plant001-aa.json"), JSON.stringify({
    id: "kiro-plant001-aa", kind: "review", status: "completed", startedAt: NOW(), resultBytes: 13,
  }));
  writeFileSync(join(planted, "kiro-plant001-aa.out"), "ATTACKER TEXT");
  useDefaultPathIn(home);
  symlinkSync(planted, join(home, DEFAULT_DIR_NAME));
  const store = await freshStore();
  // statSync followed the link, so the uid check passed and records landed in
  // whatever the link pointed at. The by-id path resolved through it too.
  for (const call of [() => store.listJobs(), () => store.loadJob("kiro-plant001-aa"), () => store.readJobResult("kiro-plant001-aa")]) {
    assert.throws(call, /symbolic link/);
  }
});

test("an unwritable store raises rather than losing the record silently", async () => {
  mkdirSync(jobsDir, { recursive: true, mode: 0o500 });
  const store = await freshStore();
  try {
    assert.throws(() => store.saveJob({ id: "kiro-unwrit01-aa", kind: "review", status: "running", startedAt: NOW() }), /EACCES|EPERM/);
  } finally {
    chmodSync(jobsDir, 0o700);
  }
});

// --- the pre-upgrade store ---

test("a legacy shared store is tightened, drained and left readable", async (t) => {
  if (!HAVE_UID) return t.skip("no uid on this platform");
  const home = join(tmpDir, "leghome");
  const legacy = join(home, LEGACY_DIR_NAME);
  mkdirSync(legacy, { recursive: true, mode: 0o755 });
  // A pre-split record: the transcript lives inside the metadata.
  writeFileSync(join(legacy, "kiro-old00001-aa.json"), JSON.stringify({
    id: "kiro-old00001-aa", kind: "review", status: "completed", startedAt: AT(1_700_000_000_000),
    finishedAt: AT(1_700_000_000_000), result: "the old review body",
  }), { mode: 0o644 });
  // And one in the current shape, world-readable because rename keeps the mode.
  plant(legacy, "kiro-old00002-aa", { bytes: 32, finishedAt: AT(1_700_000_100_000) });
  chmodSync(join(legacy, "kiro-old00002-aa.out"), 0o644);
  // Not ours: must be left exactly where it is.
  writeFileSync(join(legacy, "notes.md"), "operator notes");

  useDefaultPathIn(home);
  const store = await freshStore();
  // A read-only command is enough to trigger it, so a user who only runs
  // `status` still gets the old directory carried over.
  const listed = store.listJobs().map((j) => j.id).sort();

  assert.deepEqual(listed, ["kiro-old00001-aa", "kiro-old00002-aa"]);
  // The inline body is still reachable; draining these was the only way the
  // compatibility code for that shape had anything left to read.
  assert.equal(store.readJobResult("kiro-old00001-aa"), "the old review body");
  const target = join(home, DEFAULT_DIR_NAME);
  assert.equal(statSync(join(target, "kiro-old00002-aa.out")).mode & 0o077, 0, "a migrated transcript stayed world-readable");
  assert.deepEqual(readdirSync(legacy), ["notes.md"], "an unrelated file was moved or removed");
  assert.equal(statSync(legacy).mode & 0o077, 0, "the old directory was left world-readable");
});

test("migration leaves a job that is still running where it is", async (t) => {
  if (!HAVE_UID) return t.skip("no uid on this platform");
  const home = join(tmpDir, "busyhome");
  const legacy = join(home, LEGACY_DIR_NAME);
  mkdirSync(legacy, { recursive: true, mode: 0o700 });
  // Recent and pid-less, so reconcile still believes it: the runner there is
  // writing to these paths, and moving the record would strand it as
  // permanently "running" with its real result orphaned at the old path.
  writeFileSync(join(legacy, "kiro-busy0001-aa.json"), JSON.stringify({
    id: "kiro-busy0001-aa", kind: "rescue", status: "running", startedAt: NOW(),
  }));
  // A temporary whose writer is alive is a write in progress.
  writeFileSync(join(legacy, `.tmp-${process.pid}-1.tmp`), "half a record");
  plant(legacy, "kiro-done0001-aa", { bytes: 16 });

  useDefaultPathIn(home);
  const store = await freshStore();
  store.ensureJobsDir();
  const left = names(legacy);
  assert.ok(left.includes("kiro-busy0001-aa.json"), "a running job was migrated out from under its runner");
  assert.ok(left.includes(`.tmp-${process.pid}-1.tmp`), "a live writer's temporary was removed");
  assert.equal(left.includes("kiro-done0001-aa.json"), false, "a finished record was not migrated");
});

// --- pruning: age and count ---

test("terminal records past the TTL go; running ones never do", async () => {
  const store = await freshStore();
  plant(jobsDir, "kiro-oldjob01-aa", { bytes: 8, finishedAt: AT(Date.now() - 10 * 86_400_000) });
  plant(jobsDir, "kiro-newjob01-aa", { bytes: 8 });
  writeFileSync(join(jobsDir, "kiro-livejob1-aa.json"), JSON.stringify({
    id: "kiro-livejob1-aa", kind: "review", status: "running", startedAt: NOW(),
  }));
  store.pruneJobs();
  const left = names(jobsDir);
  assert.equal(left.includes("kiro-oldjob01-aa.json"), false, "an expired record survived");
  assert.equal(left.includes("kiro-oldjob01-aa.out"), false, "an expired transcript survived");
  assert.ok(left.includes("kiro-newjob01-aa.json"));
  assert.ok(left.includes("kiro-livejob1-aa.json"), "a running job was pruned");
});

test("the count cap keeps the newest, whatever their age", async () => {
  const store = await freshStore();
  for (let i = 0; i < 5; i++) {
    plant(jobsDir, `kiro-cap0000${i}-aa`, { bytes: 8, finishedAt: AT(Date.now() - i * 1000) });
  }
  process.env.KIRO_PLUGIN_MAX_JOBS = "2";
  try {
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOBS;
  }
  assert.deepEqual(
    names(jobsDir).filter((n) => n.endsWith(".json")),
    ["kiro-cap00000-aa.json", "kiro-cap00001-aa.json"],
  );
});

test("pruning goes by finish time, not by start time", async () => {
  const store = await freshStore();
  // Two overlapping background jobs: the one that started first finished last.
  // Ordering by startedAt deleted the newest result, and `result` then quietly
  // returned an older transcript.
  const t0 = Date.now();
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "kiro-first001-aa.json"), JSON.stringify({
    id: "kiro-first001-aa", kind: "review", status: "completed", startedAt: AT(t0 - 9000), finishedAt: AT(t0 - 1000), resultBytes: 8,
  }));
  writeFileSync(join(jobsDir, "kiro-first001-aa.out"), "xxxxxxxx");
  writeFileSync(join(jobsDir, "kiro-second01-aa.json"), JSON.stringify({
    id: "kiro-second01-aa", kind: "review", status: "completed", startedAt: AT(t0 - 5000), finishedAt: AT(t0 - 4000), resultBytes: 8,
  }));
  writeFileSync(join(jobsDir, "kiro-second01-aa.out"), "xxxxxxxx");
  process.env.KIRO_PLUGIN_MAX_JOBS = "1";
  try {
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOBS;
  }
  assert.deepEqual(names(jobsDir).filter((n) => n.endsWith(".json")), ["kiro-first001-aa.json"]);
});

// --- pruning: the byte budget ---

test("the byte budget trims older runs and keeps each one that still fits", async () => {
  const store = await freshStore();
  // Newest first: the newest is exempt, then each older one is kept while it
  // fits. Accumulating the doomed ones too overstated the total.
  plant(jobsDir, "kiro-bb000003-aa", { bytes: 900, finishedAt: AT(Date.now() - 1000) });
  plant(jobsDir, "kiro-bb000002-aa", { bytes: 900, finishedAt: AT(Date.now() - 2000) });
  plant(jobsDir, "kiro-bb000009-aa", { bytes: 5000, finishedAt: AT(Date.now() - 3000) });
  plant(jobsDir, "kiro-bb000001-aa", { bytes: 50, finishedAt: AT(Date.now() - 4000) });
  process.env.KIRO_PLUGIN_MAX_JOB_BYTES = "1000";
  try {
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOB_BYTES;
  }
  const left = names(jobsDir);
  assert.ok(left.includes("kiro-bb000003-aa.out"), "the newest transcript was charged and deleted");
  assert.ok(left.includes("kiro-bb000002-aa.out"), "an older transcript that fitted was deleted");
  assert.equal(left.includes("kiro-bb000009-aa.out"), false, "an oversized older transcript survived");
  // One oversized record must not doom the ones behind it that still fit.
  assert.ok(left.includes("kiro-bb000001-aa.out"), "a record behind the oversized one was dragged down with it");
});

test("the newest run is retained unconditionally and not charged", async () => {
  const store = await freshStore();
  // Raising the output cap above the byte budget used to mean the next job
  // start deleted the run just finished, before anyone had read it.
  plant(jobsDir, "kiro-huge0001-aa", { bytes: 100_000, finishedAt: AT(Date.now() - 1000) });
  plant(jobsDir, "kiro-small001-aa", { bytes: 500, finishedAt: AT(Date.now() - 2000) });
  process.env.KIRO_PLUGIN_MAX_JOB_BYTES = "64000";
  try {
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOB_BYTES;
  }
  const left = names(jobsDir);
  assert.ok(left.includes("kiro-huge0001-aa.out"), "the newest run was pruned");
  assert.ok(left.includes("kiro-small001-aa.out"), "an older record that fitted was pruned");
});

test("a record with no output does not spend the byte-budget exemption", async () => {
  const store = await freshStore();
  // A launch failure or a cancelled run with no output is often the newest
  // record, and it took the floor with it -- leaving the actual latest
  // transcript charged on its own and deleted by the very next job start.
  plant(jobsDir, "kiro-real0001-aa", { bytes: 4096, finishedAt: AT(Date.now() - 6000) });
  writeFileSync(join(jobsDir, "kiro-none0001-aa.json"), JSON.stringify({
    id: "kiro-none0001-aa", kind: "rescue", status: "failed",
    startedAt: AT(Date.now() - 3000), finishedAt: AT(Date.now() - 3000),
    note: "ERROR: could not start the Kiro runner",
  }));
  process.env.KIRO_PLUGIN_MAX_JOB_BYTES = "2048";
  try {
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOB_BYTES;
  }
  const left = names(jobsDir);
  assert.ok(left.includes("kiro-real0001-aa.out"), "the latest transcript was deleted");
  assert.ok(left.includes("kiro-real0001-aa.json"), "the latest record was deleted");
});

test("a transcript with no recorded size is charged by what it actually is", async () => {
  const store = await freshStore();
  // Summed as a string, resultBytes concatenated and inflated the accumulator;
  // absent, it counted as zero and 30 KB sat inside a 100-byte budget.
  plant(jobsDir, "kiro-newest01-aa", { bytes: 10, finishedAt: AT(Date.now() - 1000) });
  for (const [i, at] of [2000, 3000, 4000].entries()) {
    plant(jobsDir, `kiro-nosize0${i}-aa`, { bytes: 10_000, finishedAt: AT(Date.now() - at), recordSize: false });
  }
  process.env.KIRO_PLUGIN_MAX_JOB_BYTES = "100";
  try {
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOB_BYTES;
  }
  const left = names(jobsDir).filter((n) => n.startsWith("kiro-nosize") && n.endsWith(".out"));
  assert.deepEqual(left, [], `nothing was charged: ${left}`);
});

// --- pruning: files nothing can read ---

test("an unreadable record keeps its transcript while it is young, and loses it when old", async () => {
  const store = await freshStore();
  mkdirSync(jobsDir, { recursive: true });
  // Ours by name but unreadable by every other code path. The age grace exists
  // so a record that merely failed to parse this time does not lose its output.
  writeFileSync(join(jobsDir, "kiro-young001-aa.json"), '{"id":"kiro-young001-aa","kind":"rev');
  writeFileSync(join(jobsDir, "kiro-young001-aa.out"), "the review body");
  writeFileSync(join(jobsDir, "kiro-aged0001-aa.json"), '{"id":"kiro-aged0001-aa","kind":"rev');
  writeFileSync(join(jobsDir, "kiro-aged0001-aa.out"), "the review body");
  age(jobsDir, "kiro-aged0001-aa.json", 10 * 86_400_000);
  age(jobsDir, "kiro-aged0001-aa.out", 10 * 86_400_000);
  store.pruneJobs();
  const left = names(jobsDir);
  assert.ok(left.includes("kiro-young001-aa.out"), "a young unreadable record lost its transcript");
  assert.equal(left.includes("kiro-aged0001-aa.json"), false, "an expired unreadable record survived");
  assert.equal(left.includes("kiro-aged0001-aa.out"), false, "an expired orphaned transcript survived");
});

test("orphaned transcripts survive on age alone only while the store fits", async () => {
  const store = await freshStore();
  mkdirSync(jobsDir, { recursive: true });
  // Nothing can read them and they were charged nothing, so three of them held
  // 600 KB against a 1 KB budget for the full seven days.
  for (const n of ["a", "b", "c"]) writeFileSync(join(jobsDir, `kiro-orph000${n}-aa.out`), "o".repeat(200 * 1024));
  writeFileSync(join(jobsDir, "kiro-orphtiny-aa.out"), "o".repeat(10));

  process.env.KIRO_PLUGIN_MAX_JOB_BYTES = "1000000";
  try {
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOB_BYTES;
  }
  assert.equal(names(jobsDir).filter((n) => n.startsWith("kiro-orph")).length, 4, "a young orphan was swept while the store fitted");

  process.env.KIRO_PLUGIN_MAX_JOB_BYTES = "1000";
  try {
    // Charged bytes have to be over budget for the sweep to fire, so give it a
    // charged pair: the newest is exempt, the second is charged 900 bytes.
    plant(jobsDir, "kiro-charged1-aa", { bytes: 900, finishedAt: AT(Date.now() - 1000) });
    plant(jobsDir, "kiro-charged2-aa", { bytes: 900, finishedAt: AT(Date.now() - 2000) });
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOB_BYTES;
  }
  assert.deepEqual(names(jobsDir).filter((n) => n.startsWith("kiro-orph")), [], "unreachable bytes stayed inside the budget");
});

test("a temporary is protected only while it is plausibly a write in progress", async () => {
  const store = await freshStore();
  mkdirSync(jobsDir, { recursive: true });
  // Live writer, young: removing it makes its rename fail with ENOENT, and a
  // finished run is then reported as never having recorded a result.
  writeFileSync(join(jobsDir, `.tmp-${process.pid}-1.tmp`), "in flight");
  // Writer gone: abandoned, and it goes whatever the budget says.
  writeFileSync(join(jobsDir, ".tmp-4194304-2.tmp"), "abandoned");
  // Live pid but far too old to be a single write. pid 1 is always alive, so
  // liveness alone protected this for ever -- the state of any abandoned
  // temporary after a reboot on a platform where tmpdir persists.
  writeFileSync(join(jobsDir, ".tmp-1-3.tmp"), "recycled");
  age(jobsDir, ".tmp-1-3.tmp", 30 * 60_000);
  store.pruneJobs();
  const left = names(jobsDir);
  assert.ok(left.includes(`.tmp-${process.pid}-1.tmp`), "a live writer's temporary was removed");
  assert.equal(left.includes(".tmp-4194304-2.tmp"), false, "an abandoned temporary survived");
  assert.equal(left.includes(".tmp-1-3.tmp"), false, "a temporary with a recycled pid survived");
});

test("pruning leaves files it did not write strictly alone", async () => {
  const store = await freshStore();
  mkdirSync(jobsDir, { recursive: true });
  // An operator who points KIRO_PLUGIN_JOBS_DIR at a directory of their own
  // must not lose anything in it. isValidJobId is far too permissive to decide
  // that: it accepts "package".
  const foreign = ["notes.md", "package.json", "README", "handwritten.tmp", "kiro-not-an-id-at-all.json"];
  for (const name of foreign) writeFileSync(join(jobsDir, name), `keep ${name}`);
  for (const name of foreign) age(jobsDir, name, 30 * 86_400_000);
  process.env.KIRO_PLUGIN_JOB_TTL_MS = "1";
  process.env.KIRO_PLUGIN_MAX_JOB_BYTES = "1";
  try {
    store.pruneJobs();
  } finally {
    delete process.env.KIRO_PLUGIN_MAX_JOB_BYTES;
  }
  for (const name of foreign) {
    assert.ok(existsSync(join(jobsDir, name)), `${name} was removed`);
    assert.equal(readFileSync(join(jobsDir, name), "utf-8"), `keep ${name}`, `${name} was rewritten`);
  }
});
