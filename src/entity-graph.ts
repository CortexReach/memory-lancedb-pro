/**
 * Entity Relationship Layer
 * Extracts entities from memory text and stores relationships in LanceDB.
 * Uses regex patterns + category heuristics (no LLM needed).
 */

// ============================================================================
// Types
// ============================================================================

export type EntityCategory = "person" | "project" | "tool" | "location" | "preference" | "organization" | "other";

export interface Entity {
  name: string;
  category: EntityCategory;
  normalized: string;
}

export interface Relationship {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  lastSeen: number;
  sourceMemoryId?: string;
}

export interface EntityProfile {
  name: string;
  category: EntityCategory;
  factCount: number;
  relationships: Relationship[];
  firstSeen: number;
  lastSeen: number;
}

export interface EntityGraphConfig {
  enabled: boolean;
}

// ============================================================================
// Entity Extraction (regex-based)
// ============================================================================

/** Common patterns for entity extraction */
const ENTITY_PATTERNS: Array<{ pattern: RegExp; category: EntityCategory }> = [
  // Projects: words with underscores/hyphens, or camelCase (code-like)
  { pattern: /\b([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)\b/gi, category: "project" },
  // Tools/frameworks: common known names
  { pattern: /\b(React|Vue|Angular|Svelte|Next\.?js|Node\.?js|Python|TypeScript|JavaScript|Rust|Go|Docker|Kubernetes|Git|Linux|PostgreSQL|Redis|MongoDB|Elasticsearch|LanceDB|OpenAI|Anthropic|Claude|GPT)\b/gi, category: "tool" },
  // Locations: capitalized multi-word phrases (basic heuristic)
  { pattern: /\b((?:San Francisco|New York|London|Tokyo|Istanbul|Berlin|Paris|Dubai|Munich|Amsterdam|Singapore|Hong Kong|Toronto|Sydney|Los Angeles|Chicago|Seattle|Austin|Miami))\b/gi, category: "location" },
  // Organizations: common suffixes
  { pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?: Inc| LLC| Ltd| Corp| GmbH| AG| Co| Company| Labs| Foundation| Institute))\b/g, category: "organization" },
  // Preferences: "prefers X", "likes X", "doesn't like X"
  { pattern: /\b(prefers?|likes?|dislikes?|loves?|hates?|enjoys?|avoids?)\s+([a-zA-Z][\w\s]{2,30}?)\b/gi, category: "preference" },
];

/** Extract entities from text using regex patterns */
export function extractEntities(text: string): Entity[] {
  const seen = new Map<string, Entity>();

  for (const { pattern, category } of ENTITY_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0].trim();
      const name = match[1] ? match[1].trim() : raw;
      if (!name || name.length < 2 || name.length > 60) continue;

      const normalized = name.toLowerCase();
      if (seen.has(normalized)) continue;

      seen.set(normalized, { name, category, normalized });
    }
  }

  return Array.from(seen.values());
}

/** Extract relationships from text */
export function extractRelationships(text: string, memoryId?: string): Relationship[] {
  const relationships: Relationship[] = [];
  const now = Date.now();

  // Pattern: "X maintains/uses/works on/develops/leads Y"
  const actionPatterns = [
    { re: /(\w+(?:\s\w+)?)\s+(maintains|uses|works on|develops|leads|manages|created|built|owns|runs|contributes to)\s+([a-zA-Z][\w\s]{2,40}?)\b/gi, pred: (m: RegExpExecArray) => m[2].toLowerCase() },
    { re: /(\w+(?:\s\w+)?)\s+(is part of|works at|works for|belongs to|joined|left)\s+([a-zA-Z][\w\s]{2,40}?)\b/gi, pred: (m: RegExpExecArray) => m[2].toLowerCase() },
    { re: /(\w+(?:\s\w+)?)\s+(prefers|likes|dislikes|chose|switched to)\s+([a-zA-Z][\w\s]{2,40}?)\b/gi, pred: (m: RegExpExecArray) => m[2].toLowerCase() },
  ];

  for (const { re, pred } of actionPatterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      relationships.push({
        subject: match[1].trim(),
        predicate: pred(match),
        object: match[3].trim(),
        confidence: 0.7,
        lastSeen: now,
        sourceMemoryId: memoryId,
      });
    }
  }

  return relationships;
}

// ============================================================================
// Entity Graph (in-memory + LanceDB-backed)
// ============================================================================

export interface EntityGraph {
  extractEntities(text: string): Entity[];
  addRelationship(rel: Relationship): void;
  addEntitiesAndRelationships(text: string, memoryId?: string): void;
  getRelated(entity: string, depth?: number): Relationship[];
  getEntityProfile(name: string): EntityProfile;
  getAllEntities(): Entity[];
  getStats(): { entityCount: number; relationshipCount: number };
}

/**
 * In-memory entity graph implementation.
 * LanceDB persistence can be added later if needed for durability across restarts.
 */
export function createEntityGraph(config: EntityGraphConfig = { enabled: true }): EntityGraph {
  if (!config.enabled) {
    return createNoopEntityGraph();
  }

  const entities = new Map<string, Entity>();
  const relationships = new Map<string, Relationship[]>();
  const entityTimestamps = new Map<string, { firstSeen: number; lastSeen: number }>();

  function getRelKey(subject: string, predicate: string, object: string): string {
    return `${subject.toLowerCase()}::${predicate.toLowerCase()}::${object.toLowerCase()}`;
  }

  function addRelationship(rel: Relationship): void {
    const key = getRelKey(rel.subject, rel.predicate, rel.object);
    const existing = relationships.get(key);
    if (existing) {
      existing[0].confidence = Math.min(1, existing[0].confidence + 0.05);
      existing[0].lastSeen = rel.lastSeen;
      if (rel.sourceMemoryId) existing[0].sourceMemoryId = rel.sourceMemoryId;
    } else {
      relationships.set(key, [rel]);
    }

    // Track entity timestamps
    const now = rel.lastSeen;
    for (const name of [rel.subject, rel.object]) {
      const normalized = name.toLowerCase();
      const ts = entityTimestamps.get(normalized);
      if (ts) {
        ts.lastSeen = now;
      } else {
        entityTimestamps.set(normalized, { firstSeen: now, lastSeen: now });
      }
    }
  }

  return {
    extractEntities,

    addRelationship,

    addEntitiesAndRelationships(text: string, memoryId?: string): void {
      const extracted = extractEntities(text);
      for (const entity of extracted) {
        if (!entities.has(entity.normalized)) {
          entities.set(entity.normalized, entity);
        }
      }
      const rels = extractRelationships(text, memoryId);
      for (const rel of rels) {
        addRelationship(rel);
      }
    },

    getRelated(entity: string, depth = 1): Relationship[] {
      const normalized = entity.toLowerCase();
      const visited = new Set<string>();
      const result: Relationship[] = [];

      function collect(name: string, currentDepth: number): void {
        if (currentDepth > depth) return;
        for (const [, rels] of relationships) {
          for (const rel of rels) {
            const key = getRelKey(rel.subject, rel.predicate, rel.object);
            if (visited.has(key)) continue;
            if (rel.subject.toLowerCase() === name || rel.object.toLowerCase() === name) {
              visited.add(key);
              result.push(rel);
              // Recurse to the "other side"
              const next = rel.subject.toLowerCase() === name ? rel.object : rel.subject;
              collect(next, currentDepth + 1);
            }
          }
        }
      }

      collect(normalized, 0);
      return result;
    },

    getEntityProfile(name: string): EntityProfile {
      const normalized = name.toLowerCase();
      const entity = entities.get(normalized);
      const ts = entityTimestamps.get(normalized);
      const rels = this.getRelated(name, 1);

      return {
        name: entity?.name ?? name,
        category: entity?.category ?? "other",
        factCount: rels.length,
        relationships: rels,
        firstSeen: ts?.firstSeen ?? Date.now(),
        lastSeen: ts?.lastSeen ?? Date.now(),
      };
    },

    getAllEntities(): Entity[] {
      return Array.from(entities.values());
    },

    getStats(): { entityCount: number; relationshipCount: number } {
      return {
        entityCount: entities.size,
        relationshipCount: relationships.size,
      };
    },
  };
}

function createNoopEntityGraph(): EntityGraph {
  return {
    extractEntities: () => [],
    addRelationship: () => {},
    addEntitiesAndRelationships: () => {},
    getRelated: () => [],
    getEntityProfile: (name: string) => ({ name, category: "other", factCount: 0, relationships: [], firstSeen: 0, lastSeen: 0 }),
    getAllEntities: () => [],
    getStats: () => ({ entityCount: 0, relationshipCount: 0 }),
  };
}
