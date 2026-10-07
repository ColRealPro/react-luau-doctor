import { findNodeAtLocation, modify, parseTree } from "jsonc-parser";
import type { WorkspaceEdit } from "vscode-languageserver/node";

export function disableProjectRuleEdit(
  uri: string,
  source: string,
  version: number | null,
  rule: string,
  create: boolean,
): WorkspaceEdit {
  const parsed = create && !source ? {} : JSON.parse(source);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Project config must be a JSON object");

  if (
    parsed.rules !== undefined &&
    (!parsed.rules ||
      typeof parsed.rules !== "object" ||
      Array.isArray(parsed.rules))
  )
    throw new Error("Project config rules must be a JSON object");

  const tree = parseTree(source);

  for (const object of [tree, tree && findNodeAtLocation(tree, ["rules"])]) {
    const keys =
      object?.children?.map((property) => property.children?.[0]?.value) ?? [];

    if (new Set(keys).size !== keys.length)
      throw new Error("Remove duplicate config keys before disabling a rule");
  }

  const indent = source.match(/^[\t ]+(?=")/m)?.[0] ?? "  ";
  const eol = source.match(/\r\n|\n|\r/)?.[0] ?? "\n";

  const edits = modify(source, ["rules", rule], "off", {
    formattingOptions: {
      insertSpaces: !indent.includes("\t"),
      tabSize: indent.length,
      eol,
    },
  });

  const position = (offset: number) => {
    const lines = source.slice(0, offset).split(/\r\n|\n|\r/);

    return { line: lines.length - 1, character: lines.at(-1)!.length };
  };

  return {
    documentChanges: [
      ...(create ? [{ kind: "create" as const, uri }] : []),
      {
        textDocument: { uri, version },

        edits: edits.map((edit) => ({
          range: {
            start: position(edit.offset),
            end: position(edit.offset + edit.length),
          },

          newText: edit.content,
        })),
      },
    ],
  };
}
