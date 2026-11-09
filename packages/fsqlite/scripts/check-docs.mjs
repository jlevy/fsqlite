// Editorial and link checks for the repository's maintained prose, run by `pnpm verify`
// apart from the test suite so a prose problem never reports as a test failure.
import { checkEditorialSafety, checkMarkdownLinks } from './check-doc-claims.mjs'

checkEditorialSafety()
const files = checkMarkdownLinks()
console.log(`docs: editorial rules and local links hold in ${files} Markdown files`)
