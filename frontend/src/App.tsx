// thebes-poll — create a poll, vote once, watch the tally.
//
// Reads are queries (instant, one node answers). Writes are update calls
// (they go through consensus). The contract enforces every rule; this page
// only shows what the contract says.

import { useEffect, useState } from "react";
import { useQuery, useUpdate, encodeArgs, decodeVecRecord } from "@thebes/sdk";

const BACKEND = 151992746813754; // backend cid from thebes.toml

// How often the page re-reads the chain, so votes from other browsers show up.
const REFRESH_MS = 5000;
const MAX_OPTIONS = 4;

type Poll = {
  id: bigint;
  question: string;
  creator: string;
  createdAt: bigint;
  closed: boolean;
  totalVotes: bigint;
  voters: bigint;
  verified: boolean;
};
type Option = { pollId: bigint; index: bigint; text: string; votes: bigint };
type MyVote = { pollId: bigint; index: bigint };

const readPolls = (hex: string): Poll[] =>
  hex
    ? (decodeVecRecord(hex, [
        { name: "id", type: "nat" },
        { name: "question", type: "text" },
        { name: "creator", type: "text" },
        { name: "createdAt", type: "int" },
        { name: "closed", type: "bool" },
        { name: "totalVotes", type: "nat" },
        { name: "voters", type: "nat" },
        { name: "verified", type: "bool" },
      ]) as Poll[])
    : [];

const readOptions = (hex: string): Option[] =>
  hex
    ? (decodeVecRecord(hex, [
        { name: "pollId", type: "nat" },
        { name: "index", type: "nat" },
        { name: "text", type: "text" },
        { name: "votes", type: "nat" },
      ]) as Option[])
    : [];

const readMyVotes = (hex: string): MyVote[] =>
  hex
    ? (decodeVecRecord(hex, [
        { name: "pollId", type: "nat" },
        { name: "index", type: "nat" },
      ]) as MyVote[])
    : [];

// The SDK has no single-text decoder, so read a Candid `text` reply by hand:
// "DIDL", an empty type table, one value of type text (-15), then its bytes.
function decodeText(hex: string): string {
  if (!hex) return "";
  const b = (window as unknown as { EgyptBoundary?: { hexToBytes: (h: string) => Uint8Array } }).EgyptBoundary;
  if (!b) return "";
  const buf = b.hexToBytes(hex);
  if (buf.length < 6) return "";
  let off = 4;
  const readUleb = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buf[off++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const readSleb = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buf[off++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if (byte & 0x40) result -= 1n << shift;
        break;
      }
    }
    return result;
  };
  if (readUleb() !== 0n) return "";
  if (readUleb() === 0n) return "";
  if (readSleb() !== -15n) return "";
  const len = Number(readUleb());
  return new TextDecoder().decode(buf.subarray(off, off + len));
}

// The contract's success replies start with one of these (see Backend.mo).
const isSuccess = (reply: string) => /^(Created|Vote counted|Closed poll)/.test(reply);

const short = (id: string) => (id.length > 17 ? `${id.slice(0, 11)}…${id.slice(-5)}` : id);

export default function App() {
  const { call, pending, error: callError } = useUpdate();

  const me = useQuery(BACKEND, "myId", undefined, decodeText, []);
  const polls = useQuery(BACKEND, "listPolls", undefined, readPolls, []);
  const options = useQuery(BACKEND, "listOptions", undefined, readOptions, []);
  const myVotes = useQuery(BACKEND, "myVotes", undefined, readMyVotes, []);
  const seal = useQuery(BACKEND, "seal", undefined, decodeText, []);

  const [question, setQuestion] = useState("");
  const [choices, setChoices] = useState(["", ""]);
  const [message, setMessage] = useState<{ text: string; ok: boolean }>();
  const [copied, setCopied] = useState(false);

  function refreshAll() {
    polls.refetch();
    options.refetch();
    myVotes.refetch();
    seal.refetch();
  }

  // Keep the results live: votes cast from other browsers appear on their own.
  useEffect(() => {
    const t = setInterval(() => {
      polls.refetch();
      options.refetch();
      seal.refetch();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [polls.refetch, options.refetch, seal.refetch]);

  async function send(method: string, argHex: string): Promise<boolean> {
    setMessage(undefined);
    try {
      const res = await call(BACKEND, method, argHex);
      const reply = decodeText(res.reply_hex ?? res.reply ?? "");
      const ok = isSuccess(reply);
      setMessage({ text: reply || "Done", ok });
      refreshAll();
      return ok;
    } catch {
      return false; // shown via callError
    }
  }

  async function createPoll(e: React.FormEvent) {
    e.preventDefault();
    const ok = await send("createPoll", encodeArgs([question, choices]));
    if (ok) {
      setQuestion("");
      setChoices(["", ""]);
    }
  }

  function setChoice(i: number, value: string) {
    setChoices((cs) => cs.map((c, j) => (j === i ? value : c)));
  }

  async function copyId() {
    if (!me.data) return;
    await navigator.clipboard.writeText(me.data);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const myId = me.data ?? "";
  const pollList = [...(polls.data ?? [])].reverse(); // newest first
  const optionsFor = (pollId: bigint) => (options.data ?? []).filter((o) => o.pollId === pollId);
  const myChoice = (pollId: bigint) => (myVotes.data ?? []).find((v) => v.pollId === pollId)?.index;

  return (
    <main>
      <header className="top">
        <div>
          <h1>Thebes Poll</h1>
          <p className="sub">One vote per identity, enforced by the contract, counted on chain.</p>
        </div>
      </header>

      <div className="identity">
        <span className="muted">Your ID on the chain</span>
        <code title={myId}>{myId ? short(myId) : "…"}</code>
        <button className="ghost small" onClick={copyId} disabled={!myId}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <form onSubmit={createPoll}>
        <input
          placeholder="Ask a question..."
          value={question}
          maxLength={200}
          onChange={(e) => setQuestion(e.target.value)}
          required
        />
        {choices.map((c, i) => (
          <div className="row option-input" key={i}>
            <input
              placeholder={`Option ${i + 1}`}
              value={c}
              maxLength={80}
              onChange={(e) => setChoice(i, e.target.value)}
              required
            />
            {choices.length > 2 && (
              <button
                type="button"
                className="ghost danger"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setChoices((cs) => cs.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="row">
          <button type="submit" disabled={pending}>
            {pending ? "Sending..." : "Create poll"}
          </button>
          {choices.length < MAX_OPTIONS && (
            <button type="button" className="ghost" onClick={() => setChoices((cs) => [...cs, ""])}>
              + Add option
            </button>
          )}
        </div>
      </form>

      {message && <p className={message.ok ? "notice" : "error"}>{message.text}</p>}
      {callError && <p className="error">{callError}</p>}
      {polls.error && <p className="error">{polls.error}</p>}
      {polls.loading && !polls.data && <p className="muted">Reading polls from the chain...</p>}

      {polls.data && pollList.length === 0 && (
        <div className="empty">
          <p className="empty-title">No polls yet</p>
          <p className="muted">Ask the first question above.</p>
        </div>
      )}

      <ul>
        {pollList.map((poll) => {
          const choice = myChoice(poll.id);
          const voted = choice !== undefined;
          const total = Number(poll.totalVotes);
          const mine = poll.creator === myId;
          return (
            <li key={String(poll.id)}>
              <div className="poll-head">
                <h3>{poll.question}</h3>
                {poll.closed && <span className="badge">Closed</span>}
              </div>
              <p className="meta muted">
                #{String(poll.id)} · by {mine ? "you" : <code title={poll.creator}>{short(poll.creator)}</code>}
              </p>

              <div className="options">
                {optionsFor(poll.id).map((o) => {
                  const pct = total === 0 ? 0 : Math.round((Number(o.votes) / total) * 100);
                  const picked = choice === o.index;
                  return (
                    <button
                      key={String(o.index)}
                      className={`option${picked ? " picked" : ""}`}
                      disabled={pending || poll.closed || voted}
                      onClick={() => send("vote", encodeArgs([poll.id, o.index]))}
                    >
                      <span className="bar" style={{ width: `${voted || poll.closed ? pct : 0}%` }} />
                      <span className="option-text">
                        {picked && "✓ "}
                        {o.text}
                      </span>
                      {(voted || poll.closed) && (
                        <span className="count">
                          {String(o.votes)} · {pct}%
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="poll-foot">
                <span className={poll.verified ? "verified" : "broken"}>
                  {poll.verified ? "✓ tally verified" : "✗ tally mismatch"} · {String(poll.totalVotes)} votes from{" "}
                  {String(poll.voters)} voters
                </span>
                {mine && !poll.closed && (
                  <button className="ghost small" disabled={pending} onClick={() => send("closePoll", encodeArgs([poll.id]))}>
                    Close poll
                  </button>
                )}
              </div>
              {!voted && !poll.closed && <p className="hint muted">Results appear after you vote.</p>}
            </li>
          );
        })}
      </ul>

      <footer>
        <p>{seal.data || "…"}</p>
        <p className="muted">
          Contract {BACKEND} · reads are queries, every vote went through consensus
        </p>
      </footer>
    </main>
  );
}
