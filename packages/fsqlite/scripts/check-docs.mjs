// Editorial and link checks for the repository's maintained prose, run by `pnpm verify`
// apart from the test suite so a prose problem never reports as a test failure.
import { checkDataFiles, checkEditorialSafety, checkMarkdownLinks } from './check-doc-claims.mjs'

checkEditorialSafety()
const files = checkMarkdownLinks()
const data = checkDataFiles()
console.log(
  `docs: editorial rules and local links hold in ${files} Markdown files; ` +
    `${data} JSON files under docs/ parse and hold no machine-local path`,
)
