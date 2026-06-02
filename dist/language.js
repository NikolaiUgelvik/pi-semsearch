import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";
import Go from "tree-sitter-go";
import Html from "tree-sitter-html";
import Java from "tree-sitter-java";
import JavaScript from "tree-sitter-javascript";
import Php from "tree-sitter-php";
import Python from "tree-sitter-python";
import Ruby from "tree-sitter-ruby";
import Rust from "tree-sitter-rust";
import TypeScript from "tree-sitter-typescript";
const entries = [
    {
        id: "bash",
        extensions: [".sh", ".bash"],
        filenames: [".bashrc", ".bash_profile"],
        language: nativeLanguage(Bash),
    },
    {
        id: "go",
        extensions: [".go"],
        language: nativeLanguage(Go),
    },
    {
        id: "html",
        extensions: [".html", ".htm"],
        language: nativeLanguage(Html),
    },
    {
        id: "java",
        extensions: [".java"],
        language: nativeLanguage(Java),
    },
    {
        id: "javascript",
        extensions: [".js", ".jsx", ".mjs", ".cjs"],
        language: nativeLanguage(JavaScript),
    },
    {
        id: "php",
        extensions: [".php", ".phtml", ".php3", ".php4", ".php5"],
        language: nativeLanguage(Php.php),
    },
    {
        id: "python",
        extensions: [".py"],
        language: nativeLanguage(Python),
    },
    {
        id: "ruby",
        extensions: [".rb"],
        language: nativeLanguage(Ruby),
    },
    {
        id: "rust",
        extensions: [".rs"],
        language: nativeLanguage(Rust),
    },
    {
        id: "typescript",
        extensions: [".ts"],
        language: nativeLanguage(TypeScript.typescript),
    },
    {
        id: "tsx",
        extensions: [".tsx"],
        language: nativeLanguage(TypeScript.tsx),
    },
];
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const parsers = new Map();
export function languageForPath(filePath) {
    const filename = filePath.split(PATH_SEPARATOR_PATTERN).at(-1) ?? filePath;
    const lowerFilePath = filePath.toLowerCase();
    return entries.find((entry) => entry.filenames?.includes(filename) || entry.extensions.some((extension) => lowerFilePath.endsWith(extension)));
}
export function parseSource(filePath, source) {
    const entry = languageForPath(filePath);
    if (!entry) {
        return Promise.resolve({ language: "text", root: undefined });
    }
    const parser = parserFor(entry);
    const tree = parser.parse(source);
    if (!tree) {
        return Promise.resolve({ language: entry.id, root: undefined });
    }
    try {
        return Promise.resolve({ language: entry.id, root: adaptNode(tree.rootNode) });
    }
    finally {
        deleteTree(tree);
    }
}
function nativeLanguage(language) {
    return language;
}
function parserFor(entry) {
    const cached = parsers.get(entry.id);
    if (cached) {
        return cached;
    }
    const parser = new Parser();
    parser.setLanguage(entry.language);
    parsers.set(entry.id, parser);
    return parser;
}
function deleteTree(tree) {
    const maybeTree = tree;
    maybeTree.delete?.();
}
function adaptNode(node) {
    return {
        type: node.type,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        children: node.namedChildren.map(adaptNode),
    };
}
