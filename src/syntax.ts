export interface SyntaxPoint {
  row: number;
  column: number;
}

export interface SyntaxNode {
  id: number;
  type: string;
  text: string;
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
}

export interface SyntaxTree {
  rootNode: SyntaxNode;
}
