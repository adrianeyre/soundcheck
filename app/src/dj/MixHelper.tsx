import { Sparkles, Waypoints } from "lucide-react";
import { useId, useState } from "react";

import type { StartExchange } from "../assistant/assistant";
import type { Decide } from "../assistant/jev";
import type { DjSession } from "./dj-session";
import { formatBpm } from "./dj-logic";
import {
  askAssistant,
  askJev,
  decksNow,
  defaultTarget,
  type HelperPicks,
  keyLabel,
  type Match,
  matchWords,
  rankMatches,
  tempoWords,
} from "./mix-helper";

/** The ranked tracks shown at once. */
const SHOWN = 10;

/** Who else the Mix Helper can ask: the musician's Provider and Jev, each where set up. */
export interface MixHelperAsk {
  /** The Assistant's Provider, by its name ("Claude"), and a one-off exchange with it. */
  assistant?: { name: string; exchange: StartExchange } | null;
  /** The Decision Engine, where Jev is set up. */
  decide?: Decide | null;
}

export interface MixHelperProps extends MixHelperAsk {
  session: DjSession;
}

/**
 * The Mix Helper Widget: what is on each Deck now, and the Track browser's
 * tracks ranked by how well each would mix into the Deck chosen, by key on
 * the Camelot wheel and by tempo, with buttons to load one onto a Deck that
 * isn't playing. With the Assistant or Jev set up, either can be asked to
 * pick from the ranking too.
 */
export function MixHelper({ session, assistant = null, decide = null }: MixHelperProps) {
  const { layout, decks, report, library, dj } = session;
  const id = useId();
  const now = decksNow(layout, decks, report.decks, library);
  const [chosen, setChosen] = useState<number | null>(null);
  const target = chosen !== null && now[chosen]?.trackId ? chosen : defaultTarget(now, report.syncMaster);
  const into = target !== null ? now[target]! : null;
  const matches = into ? rankMatches(into, now, library) : [];
  const [asking, setAsking] = useState<"assistant" | "jev" | null>(null);
  const [picks, setPicks] = useState<{ deck: number; picks: HelperPicks } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { pending, unreadable, background } = session.analysis;
  const unanalysed = library.filter((t) => t.analysis === null).length;
  // A Deck that isn't playing, other than the one mixed into, is free to load.
  const free = now.filter((d) => !d.playing && d.deck !== target);
  const byId = new Map(matches.map((m) => [m.trackId, m]));

  const ask = async (who: "assistant" | "jev") => {
    if (!into) return;
    setAsking(who);
    setFailed(null);
    try {
      const answer =
        who === "assistant" && assistant
          ? await askAssistant(assistant.exchange, into, now, matches, unanalysed)
          : await askJev(decide!, into, now, matches);
      setPicks({ deck: into.deck, picks: answer });
    } catch (reason) {
      setFailed(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAsking(null);
    }
  };

  const loadButtons = (m: Match) => (
    <div className="row">
      {free.map((d) => (
        <button
          key={d.deck}
          type="button"
          className="btn-sm"
          aria-label={`Load ${m.title} onto Deck ${d.deck + 1}`}
          disabled={!dj}
          onClick={() => {
            const track = library.find((t) => t.id === m.trackId);
            if (track) void session.loadTrack(track, d.deck);
          }}
        >
          {d.deck + 1}
        </button>
      ))}
    </div>
  );

  const shownPicks = picks && picks.deck === target ? picks.picks : null;
  const who = shownPicks?.by === "assistant" ? "The Assistant" : "Jev";

  return (
    <section className="dj-helper panel" aria-labelledby={`${id}-heading`}>
      <div className="panel-head">
        <h2 id={`${id}-heading`}>
          <Waypoints size={18} aria-hidden />
          Mix Helper
        </h2>
      </div>

      <table className="dj-browser-table dj-helper-decks" aria-label="On the Decks">
        <thead>
          <tr>
            <th scope="col">Deck</th>
            <th scope="col">Track</th>
            <th scope="col">BPM now</th>
            <th scope="col">Key now</th>
            <th scope="col">Mix into</th>
          </tr>
        </thead>
        <tbody>
          {now.map((d) => (
            <tr key={d.deck} data-target={d.deck === target || undefined}>
              <th scope="row">{d.deck + 1}</th>
              <td>{d.title ? `${d.title}${d.playing ? " (playing)" : " (paused)"}` : "Empty"}</td>
              <td className="num">{d.trackId ? formatBpm(d.bpm) : "—"}</td>
              <td className="num">{d.trackId ? keyLabel(d.key) : "—"}</td>
              <td>
                <input
                  type="radio"
                  name={`${id}-target`}
                  aria-label={`Mix into Deck ${d.deck + 1}`}
                  checked={d.deck === target}
                  disabled={!d.trackId}
                  onChange={() => setChosen(d.deck)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="hint" role="status">
        {library.length === 0
          ? "Add tracks to the Track browser to have them matched."
          : pending > 0
            ? `Analysing the Track browser: ${pending} of ${library.length} tracks still to read their BPM and key.`
            : !background && unanalysed > 0
              ? `${unanalysed} of ${library.length} tracks haven't been analysed: load one onto a Deck to read its BPM and key.`
              : `All ${library.length - unreadable} tracks analysed${unreadable > 0 ? `; ${unreadable} couldn't be read` : ""}.`}
      </p>

      {!into ? (
        <p className="hint">Load a track onto a Deck, and the Mix Helper ranks the rest by how well each mixes into it.</p>
      ) : (
        <>
          <div className="row">
            {assistant && (
              <button type="button" className="btn-sm" disabled={asking !== null || matches.length === 0} aria-busy={asking === "assistant"} onClick={() => void ask("assistant")}>
                <Sparkles size={14} aria-hidden />
                {asking === "assistant" ? `Asking the Assistant (${assistant.name})…` : `Ask the Assistant (${assistant.name})`}
              </button>
            )}
            {decide && (
              <button type="button" className="btn-sm" disabled={asking !== null || matches.length === 0} aria-busy={asking === "jev"} onClick={() => void ask("jev")}>
                <Sparkles size={14} aria-hidden />
                {asking === "jev" ? "Asking Jev…" : "Ask Jev"}
              </button>
            )}
            {!assistant && !decide && <p className="hint">Set up the Assistant or Jev in Settings to have them pick a track too.</p>}
          </div>
          {failed && (
            <p role="alert" className="alert">
              {failed}
            </p>
          )}
          {shownPicks && (
            <section aria-label={`${who}'s picks`} className="dj-helper-picks">
              <h3>{who}&apos;s picks for Deck {target! + 1}</h3>
              <ol>
                {shownPicks.picks.map((pick) => {
                  const m = byId.get(pick.trackId);
                  if (!m) return null;
                  return (
                    <li key={pick.trackId}>
                      <strong>{m.title}</strong> · {m.bpm > 0 ? `${formatBpm(m.bpm)} BPM` : "no steady beat"} · {keyLabel(m.key)}
                      {pick.probability !== undefined && ` · ${Math.round(pick.probability * 100)}%`}
                      <div className="hint">{pick.why || matchWords(m)}</div>
                      {loadButtons(m)}
                    </li>
                  );
                })}
              </ol>
              {shownPicks.note && <p className="hint">{shownPicks.note}</p>}
            </section>
          )}
          {matches.length === 0 ? (
            <p className="hint">No other analysed tracks to match yet.</p>
          ) : (
            <div className="dj-browser-scroll">
              <table className="dj-browser-table" aria-label={`Best matches for Deck ${into.deck + 1}`}>
                <thead>
                  <tr>
                    <th scope="col">Track</th>
                    <th scope="col">BPM</th>
                    <th scope="col">Key</th>
                    <th scope="col">Why</th>
                    <th scope="col">Load</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.slice(0, SHOWN).map((m) => (
                    <tr key={m.trackId} data-fit={m.score >= 0.75 ? "good" : m.score >= 0.5 ? "fair" : "poor"}>
                      <th scope="row">{m.title}</th>
                      <td className="num" title={tempoWords(m.tempo)}>
                        {m.bpm > 0 ? formatBpm(m.bpm) : "—"}
                        {m.tempo && Math.abs(m.tempo.change) >= 0.05 && (
                          <span className="hint">{` ${m.tempo.change >= 0 ? "+" : "−"}${Math.abs(m.tempo.change).toFixed(1)}%`}</span>
                        )}
                      </td>
                      <td className="num">{keyLabel(m.key)}</td>
                      <td>{matchWords(m)}</td>
                      <td>{loadButtons(m)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
