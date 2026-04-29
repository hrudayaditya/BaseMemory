import type Database from "better-sqlite3";
import {
  type BranchRow,
  type DegreeRow,
  type FileEdgeRow,
  type FileNodeRow,
  type GraphEdgeRow,
  type GraphQueryService,
  type GraphSymbolRow,
  type PeekRow,
} from "./types.js";

type StatementBundle = {
  branches: Database.Statement<[], { branch: string }>;
  branchesFromSymbols: Database.Statement<[], { branch: string }>;
  symbolCount: Database.Statement<[string], { c: number }>;
  resolvedEdgeCount: Database.Statement<[string], { c: number }>;
  symbolById: Database.Statement<[string, string], GraphSymbolRow>;
  symbolByIds: Database.Statement<[string, string], GraphSymbolRow>;
  symbolsByDirectoryPrefix: Database.Statement<[string, string, string], GraphSymbolRow>;
  searchSymbols: Database.Statement<[string, string], GraphSymbolRow>;
  callerCount: Database.Statement<[string, string], { c: number }>;
  calleeCount: Database.Statement<[string, string], { c: number }>;
  resolvedCallersBatch: Database.Statement<[string, string], GraphEdgeRow>;
  resolvedCalleesBatch: Database.Statement<[string, string], GraphEdgeRow>;
  resolvedIncidentBatch: Database.Statement<[string, string, string], GraphEdgeRow>;
  unresolvedOutgoingBatch: Database.Statement<[string, string], GraphEdgeRow>;
  degreesBatch: Database.Statement<[string, string, string, string], { symbol_id: string; degree: number }>;
  fullGraphNodes: Database.Statement<[string], {
    file_path: string;
    language: string;
    symbol_count: number;
  }>;
  fullGraphEdges: Database.Statement<[string], {
    from_file_path: string;
    to_file_path: string;
    call_count: number;
  }>;
  peekSymbolAndChunk: Database.Statement<[string, string], {
    id: string;
    name: string;
    file_path: string;
    start_line: number;
    end_line: number;
    chunk_start_line: number | null;
    chunk_end_line: number | null;
  }>;
};

function jsonArray(values: Iterable<string>): string {
  return JSON.stringify(Array.from(values));
}

function uniqueIds(values: Iterable<string>): string[] {
  return Array.from(new Set(values));
}

function prepareStatements(db: Database.Database): StatementBundle {
  return {
    branches: db.prepare("SELECT DISTINCT branch FROM call_edges ORDER BY branch"),
    branchesFromSymbols: db.prepare("SELECT DISTINCT branch FROM branch_symbols ORDER BY branch"),
    symbolCount: db.prepare("SELECT COUNT(*) AS c FROM branch_symbols WHERE branch = ?"),
    resolvedEdgeCount: db.prepare("SELECT COUNT(*) AS c FROM call_edges WHERE branch = ? AND is_resolved = 1"),
    symbolById: db.prepare(`
      SELECT
        s.id,
        s.file_path,
        s.name,
        s.kind,
        s.start_line,
        s.start_col,
        s.end_line,
        s.end_col,
        s.language,
        s.symbol_aliases
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ? AND s.id = ?
      LIMIT 1
    `),
    symbolByIds: db.prepare(`
      SELECT
        s.id,
        s.file_path,
        s.name,
        s.kind,
        s.start_line,
        s.start_col,
        s.end_line,
        s.end_col,
        s.language,
        s.symbol_aliases
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ?
        AND s.id IN (SELECT value FROM json_each(?))
    `),
    symbolsByDirectoryPrefix: db.prepare(`
      SELECT
        s.id,
        s.file_path,
        s.name,
        s.kind,
        s.start_line,
        s.start_col,
        s.end_line,
        s.end_col,
        s.language,
        s.symbol_aliases
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ?
        AND (
          s.file_path = ?
          OR s.file_path LIKE ?
        )
      ORDER BY s.file_path ASC, s.start_line ASC, s.name ASC
    `),
    searchSymbols: db.prepare(`
      SELECT
        s.id,
        s.file_path,
        s.name,
        s.kind,
        s.start_line,
        s.start_col,
        s.end_line,
        s.end_col,
        s.language,
        s.symbol_aliases
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ?
        AND s.name LIKE '%' || ? || '%' COLLATE NOCASE
      ORDER BY length(s.name) ASC, s.name ASC
      LIMIT 20
    `),
    callerCount: db.prepare(`
      SELECT COUNT(*) AS c
      FROM call_edges
      WHERE branch = ? AND is_resolved = 1 AND to_symbol_id = ?
    `),
    calleeCount: db.prepare(`
      SELECT COUNT(*) AS c
      FROM call_edges
      WHERE branch = ? AND is_resolved = 1 AND from_symbol_id = ?
    `),
    resolvedCallersBatch: db.prepare(`
      SELECT
        ce.id,
        ce.branch,
        ce.from_symbol_id,
        ce.caller_file_path,
        ce.target_name,
        ce.target_file_path,
        ce.target_kind,
        ce.to_symbol_id,
        ce.call_type,
        ce.line,
        ce.col,
        ce.is_resolved
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 1
        AND ce.to_symbol_id IN (SELECT value FROM json_each(?))
    `),
    resolvedCalleesBatch: db.prepare(`
      SELECT
        ce.id,
        ce.branch,
        ce.from_symbol_id,
        ce.caller_file_path,
        ce.target_name,
        ce.target_file_path,
        ce.target_kind,
        ce.to_symbol_id,
        ce.call_type,
        ce.line,
        ce.col,
        ce.is_resolved
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 1
        AND ce.from_symbol_id IN (SELECT value FROM json_each(?))
    `),
    resolvedIncidentBatch: db.prepare(`
      SELECT
        ce.id,
        ce.branch,
        ce.from_symbol_id,
        ce.caller_file_path,
        ce.target_name,
        ce.target_file_path,
        ce.target_kind,
        ce.to_symbol_id,
        ce.call_type,
        ce.line,
        ce.col,
        ce.is_resolved
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 1
        AND (
          ce.from_symbol_id IN (SELECT value FROM json_each(?))
          OR ce.to_symbol_id IN (SELECT value FROM json_each(?))
        )
    `),
    unresolvedOutgoingBatch: db.prepare(`
      SELECT
        ce.id,
        ce.branch,
        ce.from_symbol_id,
        ce.caller_file_path,
        ce.target_name,
        ce.target_file_path,
        ce.target_kind,
        ce.to_symbol_id,
        ce.call_type,
        ce.line,
        ce.col,
        ce.is_resolved
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 0
        AND ce.from_symbol_id IN (SELECT value FROM json_each(?))
    `),
    degreesBatch: db.prepare(`
      SELECT symbol_id, COUNT(*) AS degree
      FROM (
        SELECT from_symbol_id AS symbol_id
        FROM call_edges
        WHERE branch = ?
          AND is_resolved = 1
          AND from_symbol_id IN (SELECT value FROM json_each(?))
        UNION ALL
        SELECT to_symbol_id AS symbol_id
        FROM call_edges
        WHERE branch = ?
          AND is_resolved = 1
          AND to_symbol_id IN (SELECT value FROM json_each(?))
      )
      GROUP BY symbol_id
    `),
    fullGraphNodes: db.prepare(`
      SELECT
        s.file_path,
        MIN(s.language) AS language,
        COUNT(*) AS symbol_count
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      WHERE bs.branch = ?
      GROUP BY s.file_path
      ORDER BY s.file_path
    `),
    fullGraphEdges: db.prepare(`
      SELECT
        ce.caller_file_path AS from_file_path,
        ce.target_file_path AS to_file_path,
        COUNT(*) AS call_count
      FROM call_edges ce
      WHERE ce.branch = ?
        AND ce.is_resolved = 1
        AND ce.caller_file_path IS NOT NULL
        AND ce.target_file_path IS NOT NULL
        AND ce.caller_file_path != ce.target_file_path
      GROUP BY ce.caller_file_path, ce.target_file_path
      ORDER BY ce.caller_file_path, ce.target_file_path
    `),
    peekSymbolAndChunk: db.prepare(`
      SELECT
        s.id,
        s.name,
        s.file_path,
        s.start_line,
        s.end_line,
        c.start_line AS chunk_start_line,
        c.end_line AS chunk_end_line
      FROM symbols s
      INNER JOIN branch_symbols bs ON bs.symbol_id = s.id
      LEFT JOIN chunks c
        ON c.file_path = s.file_path
       AND c.start_line <= s.start_line
       AND c.end_line >= s.end_line
      WHERE bs.branch = ? AND s.id = ?
      ORDER BY
        CASE WHEN c.chunk_id IS NULL THEN 1 ELSE 0 END ASC,
        (c.end_line - c.start_line) ASC
      LIMIT 1
    `),
  };
}

export function createGraphQueries(db: Database.Database): GraphQueryService {
  const statements = prepareStatements(db);

  return {
    listBranches() {
      const discovered = statements.branches.all().map((row: BranchRow) => row.branch);
      const fallback = statements.branchesFromSymbols.all().map((row: BranchRow) => row.branch);
      return Array.from(new Set([...discovered, ...fallback]));
    },
    getSymbolCount(branch) {
      return statements.symbolCount.get(branch)?.c ?? 0;
    },
    getResolvedEdgeCount(branch) {
      return statements.resolvedEdgeCount.get(branch)?.c ?? 0;
    },
    getSymbolById(branch, symbolId) {
      return statements.symbolById.get(branch, symbolId);
    },
    getSymbolsByIds(branch, symbolIds) {
      const ids = uniqueIds(symbolIds);
      if (ids.length === 0) {
        return new Map();
      }
      const rows = statements.symbolByIds.all(branch, jsonArray(ids));
      return new Map(rows.map((row: GraphSymbolRow) => [row.id, row]));
    },
    getSymbolsByDirectoryPrefix(branch, directoryPath) {
      const normalized = directoryPath.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!normalized) {
        return [];
      }
      return statements.symbolsByDirectoryPrefix.all(branch, normalized, `${normalized}/%`);
    },
    searchSymbols(branch, query) {
      return statements.searchSymbols.all(branch, query);
    },
    getCallerCount(branch, symbolId) {
      return statements.callerCount.get(branch, symbolId)?.c ?? 0;
    },
    getCalleeCount(branch, symbolId) {
      return statements.calleeCount.get(branch, symbolId)?.c ?? 0;
    },
    getResolvedCallers(branch, symbolIds) {
      const ids = uniqueIds(symbolIds);
      if (ids.length === 0) {
        return [];
      }
      return statements.resolvedCallersBatch.all(branch, jsonArray(ids));
    },
    getResolvedCallees(branch, symbolIds) {
      const ids = uniqueIds(symbolIds);
      if (ids.length === 0) {
        return [];
      }
      return statements.resolvedCalleesBatch.all(branch, jsonArray(ids));
    },
    getResolvedIncident(branch, symbolIds) {
      const ids = uniqueIds(symbolIds);
      if (ids.length === 0) {
        return [];
      }
      const serialized = jsonArray(ids);
      return statements.resolvedIncidentBatch.all(branch, serialized, serialized);
    },
    getUnresolvedOutgoing(branch, symbolIds) {
      const ids = uniqueIds(symbolIds);
      if (ids.length === 0) {
        return [];
      }
      return statements.unresolvedOutgoingBatch.all(branch, jsonArray(ids));
    },
    getDegrees(branch, symbolIds) {
      const ids = uniqueIds(symbolIds);
      if (ids.length === 0) {
        return new Map();
      }
      const rows = statements.degreesBatch.all(branch, jsonArray(ids), branch, jsonArray(ids));
      return new Map(rows.map((row: DegreeRow) => [row.symbol_id, row.degree]));
    },
    getFullGraphNodes(branch) {
      return statements.fullGraphNodes.all(branch) as FileNodeRow[];
    },
    getFullGraphEdges(branch) {
      return statements.fullGraphEdges.all(branch) as FileEdgeRow[];
    },
    getPeekSymbolAndChunk(branch, symbolId) {
      return statements.peekSymbolAndChunk.get(branch, symbolId) as PeekRow | undefined;
    },
  };
}
