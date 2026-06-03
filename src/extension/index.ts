import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createRegisteredPiSemsearchExtensionForTest } from "./registration.js"
import type { RuntimeDependencies } from "./runtime.js"

interface SemsearchRuntimeDependencies extends RuntimeDependencies {}

function createPiSemsearchExtensionForTest(dependencies?: SemsearchRuntimeDependencies): (pi: ExtensionAPI) => void {
  return createRegisteredPiSemsearchExtensionForTest(dependencies)
}

const piSemsearchExtension = createPiSemsearchExtensionForTest()

export type { SemsearchRuntimeDependencies }
export { createPiSemsearchExtensionForTest, piSemsearchExtension }
