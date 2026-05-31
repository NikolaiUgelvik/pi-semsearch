import { rangeForSlice, textForByteSlice } from "./range.js";
const CLASS_NAME_PATTERN = /class\s+([\p{L}_$][\p{L}\p{N}_$]*)/u;
const INTERFACE_NAME_PATTERN = /interface\s+([\p{L}_$][\p{L}\p{N}_$]*)/u;
const FUNCTION_DECLARATION_NAME_PATTERN = /function\s+([\p{L}_$][\p{L}\p{N}_$]*)/u;
const FUNCTION_ASSIGNMENT_NAME_PATTERN = /([\p{L}_$][\p{L}\p{N}_$]*)\s*=\s*(?:async\s+)?(?:function|\()/u;
const METHOD_NAME_PATTERN = /(?:async\s+)?([\p{L}_$][\p{L}\p{N}_$]*)\s*\(/u;
const PROPERTY_NAME_PATTERN = /^\s*([\p{L}_$][\p{L}\p{N}_$]*)\s*:\s*(?:[\p{L}_$][\p{L}\p{N}_$]*\s*\(|async\s+|function\b|\()/u;
const TEST_CALL_NAME_PATTERN = /^\s*(?:test|it)\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/u;
const SYMBOL_KIND_BY_NODE_TYPE = [
    ["interface", "interface"],
    ["class", "class"],
    ["method", "method"],
    ["function", "function"],
];
const NAME_PATTERN_BY_KIND = {
    class: CLASS_NAME_PATTERN,
    interface: INTERFACE_NAME_PATTERN,
    method: METHOD_NAME_PATTERN,
    module: METHOD_NAME_PATTERN,
};
function extractSymbolRecords(input) {
    const symbols = input.nodes.flatMap((node) => extractNodeSymbols(input, node, undefined));
    const symbolsById = Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol]));
    return symbols.map((symbol) => ({
        ...symbol,
        childSymbolIds: symbols
            .filter((child) => child.parentSymbolId === symbol.id && symbolsById[child.id])
            .map((child) => child.id),
    }));
}
function extractNodeSymbols(input, node, parentSymbolId) {
    const kind = symbolKindFor(input.source, node);
    const symbol = kind
        ? {
            id: `${input.filePath}:${kind}:${nameFor(input.source, node, kind)}:${node.startIndex}:${node.endIndex}`,
            name: nameFor(input.source, node, kind),
            kind,
            filePath: input.filePath,
            range: rangeForSlice(input.source, node.startIndex, node.endIndex),
            parentSymbolId,
            childSymbolIds: [],
        }
        : undefined;
    return [
        ...(symbol ? [symbol] : []),
        ...node.children.flatMap((child) => extractNodeSymbols(input, child, symbol?.id ?? parentSymbolId)),
    ];
}
function symbolKindFor(source, node) {
    const text = () => textForByteSlice(source, node.startIndex, node.endIndex);
    if (objectPropertyIsFunction(node.type, text) || callIsTestFunction(node.type, text)) {
        return "function";
    }
    return symbolKindForNodeType(node.type);
}
function objectPropertyIsFunction(type, text) {
    return typeLooksLikeObjectProperty(type) && PROPERTY_NAME_PATTERN.test(text());
}
function callIsTestFunction(type, text) {
    return typeLooksLikeCall(type) && TEST_CALL_NAME_PATTERN.test(text());
}
function symbolKindForNodeType(type) {
    return SYMBOL_KIND_BY_NODE_TYPE.find(([nodeType]) => type.includes(nodeType))?.[1];
}
function nameFor(source, node, kind) {
    const text = textForByteSlice(source, node.startIndex, node.endIndex);
    return nameForKind(text, kind) ?? "anonymous";
}
function nameForKind(text, kind) {
    return kind === "function" ? functionNameFor(text) : text.match(NAME_PATTERN_BY_KIND[kind])?.[1];
}
function functionNameFor(text) {
    const testName = text.match(TEST_CALL_NAME_PATTERN)?.[2];
    return testName ? `test ${unescapeTestName(testName)}` : firstMatchedName(text, FUNCTION_NAME_PATTERNS);
}
const FUNCTION_NAME_PATTERNS = [
    PROPERTY_NAME_PATTERN,
    FUNCTION_DECLARATION_NAME_PATTERN,
    FUNCTION_ASSIGNMENT_NAME_PATTERN,
];
function firstMatchedName(text, patterns) {
    return patterns.map((pattern) => text.match(pattern)?.[1]).find((name) => name);
}
function unescapeTestName(name) {
    return name.replace(/\\(.)/g, "$1");
}
function typeLooksLikeObjectProperty(type) {
    return type === "pair" || (type.includes("property") && !type.includes("signature"));
}
function typeLooksLikeCall(type) {
    return type.includes("call");
}
export { extractSymbolRecords };
