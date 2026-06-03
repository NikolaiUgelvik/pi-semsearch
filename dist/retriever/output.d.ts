import type { RankedResult } from "../search/lexical.js";
import type { CastIndex, ChunkRecord, DiagnosticRecord, SearchInput, SearchOutput, SearchResultRetrievalDetails } from "../shared/types.js";
interface RetrieveOutputResultsInput {
    input: {
        input: SearchInput;
        index: Pick<CastIndex, "symbols">;
        readSource(filePath: string): Promise<string>;
    };
    results: RankedResult[];
    chunksById: Record<string, ChunkRecord>;
    diagnostics: string[];
    diagnosticDetails: DiagnosticRecord[];
    initialScores: Record<string, number>;
    maxContextChars: number;
    retrieval: Map<string, SearchResultRetrievalDetails>;
}
declare function outputResults(input: RetrieveOutputResultsInput): Promise<SearchOutput["results"]>;
export type { RetrieveOutputResultsInput };
export { outputResults };
