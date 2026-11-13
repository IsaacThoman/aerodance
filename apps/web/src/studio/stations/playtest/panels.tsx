// The playtest's side panels: how one attempt went, the list of attempts, and where the
// routine itself seems to cost players points.
import { JUDGEMENTS } from '../../../../../../packages/score/scorer.ts';
import type { Trouble } from '../../../../../../packages/dance/playtest.ts';
import type { Difficulty } from '../../../../../../packages/dance/format.ts';
import type { AttemptInfo } from '../../../../../../packages/dance/store.ts';
import { ago, clock } from '../../core/format.ts';
import { Button, Meter, Note, Panel } from '../../core/ui.tsx';
import { DECENT_ACCURACY, DIFFICULTY_WORDS, JUDGEMENT_ORDER, JUDGEMENT_WORDS, limbName, percent, timingWords, troubleWords } from './analysis.ts';
import type { Range } from './analysis.ts';
import type { ScoredAttempt } from './attempts.ts';

/** Whether a stretch is (near enough) the whole of another. */
const covers = (range: Range, whole: Range) => range[0] <= whole[0] + 500 && range[1] >= whole[1] - 500;
const stretch = (range: Range) => `${clock(range[0], false)}–${clock(range[1], false)}`;
/** A limb this far out on average is costing points; this far, most of them. */
const LIMB_NOTICE_DEG = 20, LIMB_OFF_DEG = 35, LIMB_FULL_DEG = 60;

export function HowItWent({ attempt, playable, waiting }: { attempt: ScoredAttempt | null; playable: Range; /** Attempts exist but none is scored yet. */ waiting: boolean }) {
  if (!attempt) return (
    <Panel title="How it went">
      <p className="muted">{waiting ? 'Scoring the attempts…' : 'Dance the routine and the result shows here: the grade, the timing, and which arms and legs were furthest from the coach\'s.'}</p>
    </Panel>
  );
  const { info, range, analysis } = attempt, { result } = analysis;
  const matched = analysis.intervals.some(i => i.score >= JUDGEMENTS[1][1]);
  const limbs = [...analysis.limbs].sort((a, b) => (b.degrees ?? -1) - (a.degrees ?? -1));
  return (
    <Panel title="How it went" aside={<span className="muted playtest-who">{info.player} · {ago(info.createdAt)}</span>}>
      {result.possibleIntervals === 0 ? (
        // Nothing in what was danced is scored (it has been left unscored since, or was never recorded).
        <p className="muted" data-accuracy="">Nothing in the part that was danced ({stretch(range)}) is scored now, so there are no points to count.</p>
      ) : (
        <div className="playtest-result" data-grade={result.grade} data-accuracy={Math.round(result.accuracy * 100)}>
          <div className={`playtest-grade grade-${result.grade}`} title="The grade the game would give">{result.grade}</div>
          <div className="playtest-score">
            <strong>{percent(result.accuracy)}</strong>
            <span>of the points{covers(range, playable) ? '' : `, ${stretch(range)}`}</span>
          </div>
        </div>
      )}
      <dl className="playtest-judgements">
        {JUDGEMENT_ORDER.map(kind => <div key={kind} className={`is-${kind}`}><dd>{result.judgements[kind]}</dd><dt>{JUDGEMENT_WORDS[kind]}</dt></div>)}
      </dl>
      <dl className="playtest-facts">
        <div><dt>Timing</dt><dd>{matched ? timingWords(result.meanOffsetMs) : 'Too few moves matched to tell'}</dd></div>
        <div>
          <dt>Seen by the camera</dt><dd>{percent(result.coverage)} of the time</dd>
          <Meter value={result.coverage} tone={result.coverage >= 0.8 ? 'good' : 'warning'} label="Share of the time the camera saw the player" />
        </div>
      </dl>
      <div className="playtest-limbs">
        <div className="field-label">Furthest from the coach, on average</div>
        <ul>
          {limbs.map(({ id, degrees }) => (
            <li key={id} data-limb={id}>
              <span>{limbName(id)}</span>
              <div className="playtest-bar" aria-hidden="true">
                {degrees !== null && <i className={degrees >= LIMB_OFF_DEG ? 'off' : degrees >= LIMB_NOTICE_DEG ? 'notice' : ''} style={{ width: `${Math.min(1, degrees / LIMB_FULL_DEG) * 100}%` }} />}
              </div>
              <em>{degrees === null ? 'not seen' : `${Math.round(degrees)}°`}</em>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

export function AttemptList({ attempts, scored, scoring, revision, playable, shown, skipped, onPick, onCount, onRemove }: {
  attempts: readonly AttemptInfo[]; scored: readonly ScoredAttempt[]; scoring: boolean;
  /** The dance's revision: attempts danced at an earlier one are marked. */
  revision: number; playable: Range;
  /** The attempt "How it went" is showing. */
  shown: string | null;
  /** Attempts left out of the heat and the trouble spots. */
  skipped: ReadonlySet<string>;
  onPick(id: string): void; onCount(id: string, count: boolean): void; onRemove(attempt: AttemptInfo): void;
}) {
  return (
    <Panel title="Attempts" aside={scoring ? <span className="muted">Scoring…</span> : attempts.length > 0 && <span className="muted">{attempts.length}</span>}>
      {!attempts.length && <p className="muted">Every attempt is kept with the dance and scored again whenever the dance changes, so after a fix you can see whether it helped.</p>}
      {attempts.length > 0 && (
        <ul className="playtest-attempts">
          {attempts.map(info => {
            const result = scored.find(s => s.info.id === info.id);
            return (
              <li key={info.id} className={shown === info.id ? 'shown' : ''} data-attempt={info.id} data-accuracy={result?.analysis.result.possibleIntervals ? Math.round(result.analysis.result.accuracy * 100) : ''}>
                <button className="playtest-attempt" onClick={() => onPick(info.id)} title="Show how this one went">
                  <strong>{info.player}</strong>
                  <span>{ago(info.createdAt)}{result && !covers(result.range, playable) ? ` · ${stretch(result.range)}` : ''}</span>
                  <em title="Scored against the dance as it is now">{!result ? '…' : result.analysis.result.possibleIntervals ? percent(result.analysis.result.accuracy) : 'not scored'}</em>
                </button>
                <Button kind="quiet" icon="trash" aria-label={`Delete ${info.player}'s attempt`} title="Delete this attempt" onClick={() => onRemove(info)} />
                <div className="playtest-attempt-foot">
                  <label className="playtest-count-it" title="Use this attempt in the Points lane and in Where points go">
                    <input type="checkbox" checked={!skipped.has(info.id)} onChange={e => onCount(info.id, e.target.checked)} />Count it
                  </label>
                  {info.revision < revision && <span className="playtest-earlier" title="Its score is against the dance as it is now">Danced before your latest changes</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function WherePointsGo({ counted, decent, troubles, measured, difficulty, onShow, onFix, onUnscore, onUseDifficulty }: {
  /** Attempts counted, how many of them did well enough to learn from, and their mean accuracy. */
  counted: { attempts: number; accuracy: number }; decent: number;
  troubles: readonly Trouble[];
  /** The difficulty the attempts suggest, and the song's. */
  measured: Difficulty | null; difficulty: Difficulty;
  onShow(trouble: Trouble): void; onFix(trouble: Trouble): void; onUnscore(trouble: Trouble): void; onUseDifficulty(difficulty: Difficulty): void;
}) {
  return (
    <Panel title="Where points go">
      {decent < 2 && (
        <p className="muted" data-trouble="waiting">
          Stretches that good attempts keep losing points on show up here, to fix or to leave unscored. One attempt can be a slip, so it takes two decent ones ({percent(DECENT_ACCURACY)} or better)
          {counted.attempts ? `: so far there ${decent === 1 ? 'is 1' : 'are none'}.` : '.'}
        </p>
      )}
      {decent >= 2 && !troubles.length && <Note kind="good">No stretch keeps losing points: {decent} decent attempts scored well all the way through.</Note>}
      {troubles.length > 0 && (
        <ul className="playtest-troubles">
          {troubles.map(t => (
            <li key={t.startMs} data-trouble={`${t.startMs}-${t.endMs}`}>
              <button className="playtest-trouble-when" onClick={() => onShow(t)} title="Select this stretch and go to it">
                <strong>{clock(t.startMs, false)}–{clock(t.endMs, false)}</strong><span>good attempts earn {percent(t.points)} here</span>
              </button>
              <p>{troubleWords(t)}</p>
              <div className="button-row">
                <Button onClick={() => onFix(t)} title="Open this stretch in Fix to change the moves">Look at it in Fix</Button>
                <Button onClick={() => onUnscore(t)} title="Players still dance it, but it no longer counts towards their score">Leave unscored</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {measured && (
        <div className="playtest-difficulty" data-measured={measured}>
          <div>
            <div className="field-label">How hard it dances</div>
            <p><strong>{DIFFICULTY_WORDS[measured]}</strong>: {counted.attempts === 1 ? 'the attempt earned' : `${counted.attempts} attempts averaged`} {percent(counted.accuracy)}.
              {measured === difficulty ? ' That\'s what the song says too.' : ` The song says ${DIFFICULTY_WORDS[difficulty]}.`}</p>
          </div>
          {measured !== difficulty && <Button onClick={() => onUseDifficulty(measured)} title={`Set the song's difficulty to ${DIFFICULTY_WORDS[measured]}`}>Use it</Button>}
        </div>
      )}
    </Panel>
  );
}
