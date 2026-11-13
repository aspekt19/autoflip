import type { ReactNode } from "react";
import type { ProofLemonlessAnswer, ProofLink, ProofPlainAnswer } from "@/domain/proof-page-runs";

export function Links({ links, heading }: { links: ProofLink[]; heading?: string }) {
  if (!links.length) return null;
  return (
    <div className="proof-links">
      {heading ? <h4>{heading}</h4> : null}
      <ul className="refuse">
        {links.map((link, index) => (
          <li key={`${link.href}-${link.label}-${index}`}>
            <a href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function inlineMarkup(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\*\*[^*]+?\*\*|\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)|\[([^\]]+?)\s+\((https?:\/\/[^\s)]+)\)\])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>);
    } else if (match[2] && match[3]) {
      nodes.push(
        <a key={`a-${key++}`} href={match[3]} target="_blank" rel="noreferrer">
          {match[2]}
        </a>,
      );
    } else if (match[4] && match[5]) {
      nodes.push(
        <a key={`a-${key++}`} href={match[5]} target="_blank" rel="noreferrer">
          {match[4]}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const takeList = (ordered: boolean): ReactNode => {
    const items: string[] = [];
    const bullet = ordered ? /^\d+\.\s+(.*)$/ : /^-\s+(.*)$/;
    while (i < lines.length) {
      const found = lines[i].match(bullet);
      if (!found) break;
      items.push(found[1]);
      i += 1;
    }
    const List = ordered ? "ol" : "ul";
    return (
      <List key={`l-${key++}`} className="refuse">
        {items.map((item, index) => (
          <li key={index}>{inlineMarkup(item)}</li>
        ))}
      </List>
    );
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^###\s+/.test(line)) {
      blocks.push(<h4 key={`h-${key++}`}>{inlineMarkup(line.replace(/^###\s+/, ""))}</h4>);
      i += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={`q-${key++}`}>
          <p>{inlineMarkup(quoted.join(" "))}</p>
        </blockquote>,
      );
      continue;
    }
    if (/^-\s+/.test(line)) {
      blocks.push(takeList(false));
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      blocks.push(takeList(true));
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && !isTableSeparator(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={`t-${key++}`} style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                {headers.map((cell) => (
                  <th key={cell}>{inlineMarkup(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{inlineMarkup(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^###\s+/.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !/^-\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i])
    ) {
      if (lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={`p-${key++}`}>{inlineMarkup(para.join(" "))}</p>);
  }
  return blocks;
}

export function VerbatimAnswer({ answer }: { answer: ProofPlainAnswer }) {
  return (
    <div className="decision-body proof-answer">
      <p>
        <strong>{answer.headline}</strong>
      </p>
      {renderBlocks(answer.verbatim)}
    </div>
  );
}

export function LemonlessAnswer({ answer }: { answer: ProofLemonlessAnswer }) {
  return (
    <div className="decision-body proof-answer">
      <p>
        <strong>Pick. </strong>
        {answer.pick}
      </p>
      <p>
        <strong>The recommendation. </strong>
        {answer.recommendation}
      </p>
      <h4>Why this car</h4>
      <p>{answer.whyThisCar}</p>
      <h4>Why this offer</h4>
      <p>{answer.whyThisOffer}</p>
      <h4>What was checked</h4>
      <ul className="refuse">
        {answer.checked.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h4>What is still unknown</h4>
      <ul className="refuse">
        {answer.unknown.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h4>What was rejected, and why</h4>
      <p>{answer.rejected}</p>
    </div>
  );
}

export function verdictLabel(verdict: string): string {
  return verdict.replaceAll("_", " ");
}
