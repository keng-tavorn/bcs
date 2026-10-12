// CI (.github/workflows/ci.yml, P1-03): did the files change since <base> touch documents only? Prints docs_only=true
// or docs_only=false, the line the workflow appends to $GITHUB_OUTPUT. Any doubt is false (scripts/lib/ci-changes.ts),
// so the full run with the e2e gate goes ahead.
import { changedSince, isDocumentsOnly } from './lib/ci-changes'

const files = changedSince(process.argv[2])
console.log(`docs_only=${files !== null && isDocumentsOnly(files)}`)
