// Citation benchmark adapter for dsh-cite-verify.
//
// Reads dsh-research-bench `data/citations/cases.jsonl`, answers every provider
// call from the case's frozen fixtures (never the network), runs the plugin's
// own verification pipeline, and prints the micro-averaged metrics required by
// the bench scoring contract.
//
// Usage: node bench/run-citations.mjs [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCitation } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const benchRoot = process.env.BENCH_DIR ?? path.resolve(here, '..', '..', 'dsh-research-bench')
const casesFile = path.join(benchRoot, 'data', 'citations', 'cases.jsonl')
const summaryFile = path.join(benchRoot, 'data', 'citations', 'SUMMARY.json')
const FIELD_PREFIXES = ['title', 'authors', 'year', 'venue', 'pages', 'version']

const cases = readFileSync(casesFile, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line))
const summary = JSON.parse(readFileSync(summaryFile, 'utf8'))

const now = () => new Date('2026-11-08T00:00:00.000Z')
/** A cache that never stores or returns anything: the bench must be hermetic. */
const noCache = { get: async () => undefined, put: async () => {} }

/** Build a client that answers only from the case's frozen provider fixtures. */
function clientFor(caseItem) {
  return {
    async get(url) {
      const route = caseItem.providers.find(candidate => url.includes(candidate.match))
      if (route === undefined) {
        return { status: 404, body: '', url, contentType: 'text/plain' }
      }
      const body = route.body === null || route.body === undefined
        ? ''
        : typeof route.body === 'string'
          ? route.body
          : JSON.stringify(route.body)
      return {
        status: route.status,
        body,
        url,
        contentType: typeof route.body === 'string' ? 'application/xml' : 'application/json',
      }
    },
  }
}

/** Predictions for one case, using only the plugin's public pipeline. */
async function predict(caseItem) {
  const outcome = await verifyCitation(caseItem.input, {
    client: clientFor(caseItem),
    cache: noCache,
    titleThreshold: 0.85,
    mailto: undefined,
    now,
  })
  const fields = new Set()
  for (const check of outcome.checks) {
    if (check.status !== 'fail' && check.status !== 'warn') continue
    for (const prefix of FIELD_PREFIXES) {
      if (check.checkId.startsWith(`chk-${prefix}-`)) fields.add(prefix)
    }
  }
  const updateNotice = outcome.checks.some(check => check.checkId.startsWith('chk-retraction-') && check.status === 'warn')
  return {
    exists: !outcome.notFound,
    mismatch_fields: [...fields].sort(),
    update_notice: updateNotice,
    status: outcome.status,
  }
}

const predictions = []
for (const caseItem of cases) predictions.push({ id: caseItem.id, category: caseItem.category, prediction: await predict(caseItem) })

// ── metrics ────────────────────────────────────────────────────────────────
const ratio = (numerator, denominator) => (denominator === 0 ? null : Number((numerator / denominator).toFixed(4)))
const scores = {
  existence: { tp: 0, fp: 0, fn: 0 },
  fields: { tp: 0, fp: 0, fn: 0 },
  notice: { tp: 0, fp: 0, fn: 0 },
  clean: { total: 0, flagged: 0 },
  exact: { total: 0, match: 0 },
}
for (const [index, caseItem] of cases.entries()) {
  const predicted = predictions[index].prediction
  const truth = caseItem.expected
  if (!truth.exists && !predicted.exists) scores.existence.tp += 1
  else if (truth.exists && !predicted.exists) scores.existence.fp += 1
  else if (!truth.exists && predicted.exists) scores.existence.fn += 1
  for (const field of predicted.mismatch_fields) {
    if (truth.mismatch_fields.includes(field)) scores.fields.tp += 1
    else scores.fields.fp += 1
  }
  for (const field of truth.mismatch_fields) {
    if (!predicted.mismatch_fields.includes(field)) scores.fields.fn += 1
  }
  if (truth.update_notice && predicted.update_notice) scores.notice.tp += 1
  else if (!truth.update_notice && predicted.update_notice) scores.notice.fp += 1
  else if (truth.update_notice && !predicted.update_notice) scores.notice.fn += 1
  if (caseItem.category === 'correct') {
    scores.clean.total += 1
    if (predicted.mismatch_fields.length > 0 || !predicted.exists || predicted.update_notice) scores.clean.flagged += 1
  }
  scores.exact.total += 1
  const sameFields = JSON.stringify([...predicted.mismatch_fields].sort()) === JSON.stringify([...truth.mismatch_fields].sort())
  if (predicted.exists === truth.exists && sameFields && predicted.update_notice === truth.update_notice) scores.exact.match += 1
}

const metrics = {
  dataset: { name: summary.dataset, version: summary.version, total: summary.total, cases: cases.length },
  plugin: '@perrylink/dsh-cite-verify',
  existence: {
    precision: ratio(scores.existence.tp, scores.existence.tp + scores.existence.fp),
    recall: ratio(scores.existence.tp, scores.existence.tp + scores.existence.fn),
    ...scores.existence,
  },
  fieldMismatch: {
    precision: ratio(scores.fields.tp, scores.fields.tp + scores.fields.fp),
    recall: ratio(scores.fields.tp, scores.fields.tp + scores.fields.fn),
    f1: ratio(2 * scores.fields.tp, 2 * scores.fields.tp + scores.fields.fp + scores.fields.fn),
    ...scores.fields,
  },
  updateNotice: {
    precision: ratio(scores.notice.tp, scores.notice.tp + scores.notice.fp),
    recall: ratio(scores.notice.tp, scores.notice.tp + scores.notice.fn),
    ...scores.notice,
  },
  cleanFalsePositiveRate: ratio(scores.clean.flagged, scores.clean.total),
  exactMatchRate: ratio(scores.exact.match, scores.exact.total),
  cleanCases: scores.clean.total,
}

const report = {
  command: 'node bench/run-citations.mjs',
  benchDir: benchRoot,
  metrics,
  predictions,
}

const jsonFlag = process.argv.indexOf('--json')
if (jsonFlag !== -1 && process.argv[jsonFlag + 1] !== undefined) {
  writeFileSync(process.argv[jsonFlag + 1], `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

console.log(`# dsh-cite-verify × dsh-research-bench (${summary.dataset} v${summary.version}, ${cases.length} cases)`)
console.log('')
console.log('| metric | value |')
console.log('|---|---:|')
for (const [key, value] of [
  ['existence precision', metrics.existence.precision],
  ['existence recall', metrics.existence.recall],
  ['field precision', metrics.fieldMismatch.precision],
  ['field recall', metrics.fieldMismatch.recall],
  ['field F1', metrics.fieldMismatch.f1],
  ['update-notice precision', metrics.updateNotice.precision],
  ['update-notice recall', metrics.updateNotice.recall],
  ['clean false-positive rate', metrics.cleanFalsePositiveRate],
  ['exact-match rate', metrics.exactMatchRate],
]) {
  console.log(`| ${key} | ${value === null ? 'n/a' : value} |`)
}
const wrong = predictions.filter((item, index) => {
  const truth = cases[index].expected
  return JSON.stringify(item.prediction.mismatch_fields) !== JSON.stringify([...truth.mismatch_fields].sort()) || item.prediction.exists !== truth.exists
})
if (wrong.length > 0) {
  console.log('')
  console.log(`Cases whose predictions differ from the label: ${wrong.length}`)
  for (const item of wrong.slice(0, 10)) console.log(`  ${item.id} (${item.category}): ${JSON.stringify(item.prediction)}`)
}
