export interface SyntaxPoint {
  row: number;
  column: number;
}

export interface SyntaxNode {
  id: number;
  type: string;
  // Comments are blanked out of text, so use sourceText when showing code to users
  text: string;
  sourceText: string;
  startIndex: number;
  endIndex: number;
  startPosition: SyntaxPoint;
  endPosition: SyntaxPoint;
  parent: SyntaxNode | null;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  isError: boolean;
  isMissing: boolean;
  hasError: boolean;
  childForFieldName(name: string): SyntaxNode | null;
  childrenForFieldName(name: string): SyntaxNode[];
}

export interface SyntaxError {
  node: SyntaxNode;
  message: string;
}

export interface SyntaxTree {
  rootNode: SyntaxNode;
  errors: SyntaxError[];
  delete?(): void;
}
