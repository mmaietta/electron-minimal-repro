// QA_SCAN_PROBE=1 build (QA_TEST_PLAN.md, check B4): the only app file, and it deliberately never names the
// electron-updater property that alpha.14 made required, so the build prints its warning for such apps.
const { app } = require("electron")
require("electron-updater")
app.whenReady().then(() => app.quit())
