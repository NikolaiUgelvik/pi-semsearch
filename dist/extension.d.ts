import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeDependencies } from "./extension-runtime.js";
interface SemsearchRuntimeDependencies extends RuntimeDependencies {
}
declare function createPiSemsearchExtensionForTest(dependencies?: SemsearchRuntimeDependencies): (pi: ExtensionAPI) => void;
declare const piSemsearchExtension: (pi: ExtensionAPI) => void;
export type { SemsearchRuntimeDependencies };
export { createPiSemsearchExtensionForTest, piSemsearchExtension };
