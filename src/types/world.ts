/** Closed, bounded World IR as represented by kadmos.world.v0. */
export interface StateDef {
  readonly id: string;
  readonly initial?: boolean;
  readonly terminal?: boolean;
  readonly description?: string;
}

export interface ContextVarDef {
  readonly type: "integer" | "string";
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly default?: number | string;
}

export interface InvariantDef {
  readonly id: string;
  readonly description?: string;
  readonly predicate: string;
}

export interface TransitionDef {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly guard: string | boolean;
  readonly directive: string | null;
  readonly effects: readonly string[];
}

/** Source form; admission fills an omitted directive with null. */
export type TransitionDefInput = Omit<TransitionDef, "directive"> & { readonly directive?: string | null };

export interface WorldSpec {
  readonly version: "kadmos.world.v0";
  readonly name: string;
  readonly description?: string;
  readonly states: readonly StateDef[];
  readonly context: Readonly<Record<string, ContextVarDef>>;
  readonly invariants: readonly InvariantDef[];
  readonly transitions: readonly TransitionDef[];
}

/** Programmatic/YAML input before canonical admission. */
export type WorldSpecInput = Omit<WorldSpec, "transitions"> & { readonly transitions: readonly TransitionDefInput[] };
