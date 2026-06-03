import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeDependencies as SemsearchRuntimeDependencies } from "./extension-runtime.js";
declare function createRegisteredPiSemsearchExtensionForTest(dependencies?: SemsearchRuntimeDependencies): (pi: ExtensionAPI) => void;
export { createRegisteredPiSemsearchExtensionForTest };
