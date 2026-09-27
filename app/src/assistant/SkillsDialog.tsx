import { ChevronLeft, ChevronRight, CornerDownLeft } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Dialog } from "../ui/Dialog";
import { skillsByCategory, type Skill, type SkillCategory } from "./skills";

export interface SkillsDialogProps {
  open: boolean;
  onClose: () => void;
  skills: readonly Skill[];
  /** Starts a Request with the Skill's command; left out where no Request can be made just now. */
  onUse?: (skill: Skill) => void;
}

/** The Category picker's choice that shows every Skill. */
const ALL = "all";

/**
 * The Skills, one at a time: what each does, its slash command and what
 * the Assistant is told. Previous and Next stay put under it, whatever its
 * length, and go round from the last to the first, so neither is ever
 * disabled under the pointer or the keyboard's focus.
 *
 * Above it, Category narrows them to one kind, such as Genres, which
 * Previous and Next then keep to, and Skill jumps straight to one of them.
 */
export function SkillsDialog({ open, onClose, skills: allSkills, onUse }: SkillsDialogProps) {
  const [category, setCategory] = useState<SkillCategory | typeof ALL>(ALL);
  const [index, setIndex] = useState(0);
  const groups = skillsByCategory(allSkills);
  const skills = category === ALL ? allSkills : (groups.find((group) => group.category === category)?.skills ?? allSkills);
  const at = skills.length > 0 ? Math.min(index, skills.length - 1) : 0;
  const skill = skills[at];
  const top = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const show = (next: number) => {
    setIndex(next);
    // A new Skill is read from its top.
    top.current?.closest(".dialog-body")?.scrollTo?.({ top: 0 });
  };
  const step = (by: number) => show((at + by + skills.length) % skills.length);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Skills"
      closeLabel="Close skills"
      className="skills-dialog"
      footer={
        skill && (
          <>
            <button type="button" className="btn-ghost" onClick={() => step(-1)} disabled={skills.length < 2}>
              <ChevronLeft size={16} aria-hidden />
              Previous
            </button>
            <p className="skills-count num" aria-live="polite">
              <span className="visually-hidden">Skill </span>
              {at + 1} of {skills.length}
            </p>
            <button type="button" className="btn-ghost" onClick={() => step(1)} disabled={skills.length < 2}>
              Next
              <ChevronRight size={16} aria-hidden />
            </button>
            {onUse && (
              <button type="button" className="btn-primary skills-use" onClick={() => onUse(skill)}>
                <CornerDownLeft size={16} aria-hidden />
                Use /{skill.name}
              </button>
            )}
          </>
        )
      }
    >
      <div ref={top} className="stack">
        {allSkills.length > 0 && (
          <div className="skills-pickers">
            <label className="field">
              Category
              <select
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value as SkillCategory | typeof ALL);
                  show(0);
                }}
              >
                <option value={ALL}>All ({allSkills.length})</option>
                {groups.map((group) => (
                  <option key={group.category} value={group.category}>
                    {group.category} ({group.skills.length})
                  </option>
                ))}
              </select>
            </label>
            <label className="field skills-picker">
              Skill
              <select value={skill?.name ?? ""} onChange={(event) => show(skills.findIndex((one) => one.name === event.target.value))}>
                {skills.map((one) => (
                  <option key={one.name} value={one.name}>
                    {one.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {skill ? (
          <article aria-labelledby={titleId} className="stack">
            <h3 id={titleId} className="skill-title">
              {skill.title}
            </h3>
            <p>
              <code className="skill-command">
                /{skill.name}
                {skill.argumentHint && <span className="skill-argument"> {skill.argumentHint}</span>}
              </code>
            </p>
            <p>{skill.description}</p>
            <h4>What the Assistant is told</h4>
            <div className="skill-instructions">{skill.instructions}</div>
          </article>
        ) : (
          <p className="hint">There are no Skills yet. Add a folder to the repo&apos;s skills folder to make one.</p>
        )}
      </div>
    </Dialog>
  );
}
