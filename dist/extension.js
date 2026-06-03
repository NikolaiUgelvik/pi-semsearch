import { createRegisteredPiSemsearchExtensionForTest } from "./extension-registration.js";
function createPiSemsearchExtensionForTest(dependencies) {
    return createRegisteredPiSemsearchExtensionForTest(dependencies);
}
const piSemsearchExtension = createPiSemsearchExtensionForTest();
export { createPiSemsearchExtensionForTest, piSemsearchExtension };
