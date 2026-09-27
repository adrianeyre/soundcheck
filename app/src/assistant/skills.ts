/**
 * Skills: named instructions the musician starts a Request with, as a slash
 * command such as `/fix-clipping`. Each is a folder of the repo's `skills/`
 * holding a `SKILL.md` (its README says how one is written), bundled at build
 * time, so a new Skill needs no code.
 *
 * A Request that starts with a Skill's command is sent with the Skill's
 * instructions, followed by whatever the musician typed after it. The
 * transcript shows what they typed.
 */

/** The kinds of Skill, in the order View skills lists them. */
export const SKILL_CATEGORIES = ["Songwriting", "Drums", "Arrangement", "Mixing", "Mastering", "Genres"] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface Skill {
  /** Its slash command, without the slash; the name of its folder. */
  name: string;
  /** What View skills calls it. */
  title: string;
  /** What kind of Skill it is, which View skills filters by. */
  category: SkillCategory;
  /** One sentence on what it does. */
  description: string;
  /** What may follow the command, such as "[genre] [tempo]"; empty when nothing is expected. */
  argumentHint: string;
  /** What the Assistant is told to do. */
  instructions: string;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A `SKILL.md`, from the folder `folder`: its front matter, between lines of
 * `---`, and the instructions after it. Throws, naming the folder, on one
 * that is missing a field or whose name isn't its folder's.
 */
export function parseSkill(folder: string, text: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`skills/${folder}/SKILL.md has no front matter.`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (field) fields.set(field[1]!, field[2]!.replace(/^(["'])(.*)\1$/, "$2").trim());
  }
  const required = (key: string) => {
    const value = fields.get(key);
    if (!value) throw new Error(`skills/${folder}/SKILL.md has no ${key}.`);
    return value;
  };
  const name = required("name");
  if (name !== folder || !NAME.test(name)) {
    throw new Error(`skills/${folder}/SKILL.md is named "${name}": a Skill is named as its folder is, in lower case and hyphens.`);
  }
  const category = required("category");
  if (!(SKILL_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`skills/${folder}/SKILL.md has the category "${category}": it must be one of ${SKILL_CATEGORIES.join(", ")}.`);
  }
  const instructions = match[2]!.trim();
  if (!instructions) throw new Error(`skills/${folder}/SKILL.md has no instructions.`);
  return {
    name,
    title: required("title"),
    category: category as SkillCategory,
    description: required("description"),
    argumentHint: fields.get("argument-hint") ?? "",
    instructions,
  };
}

/** Every `SKILL.md` given by its path, parsed, in the order of their names. */
export function skillsFrom(files: Record<string, string>): Skill[] {
  return Object.entries(files)
    .map(([path, text]) => parseSkill(path.split("/").at(-2)!, text))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The Skills in the repo's `skills/` folder. */
export const SKILLS: readonly Skill[] = skillsFrom(
  import.meta.glob<string>("../../../skills/*/SKILL.md", { query: "?raw", import: "default", eager: true }),
);

/** The categories that have Skills, in `SKILL_CATEGORIES`' order, each with its Skills in theirs. */
export function skillsByCategory(skills: readonly Skill[]): { category: SkillCategory; skills: Skill[] }[] {
  return SKILL_CATEGORIES.map((category) => ({ category, skills: skills.filter((skill) => skill.category === category) })).filter(
    (group) => group.skills.length > 0,
  );
}

/** What a Request that starts with a slash is: the Skill it names, or the name no Skill has, and what follows. */
export type SkillCommand = { skill: Skill; rest: string } | { unknown: string };

/** The Skill a Request starts with, if it starts with a slash command; null if it doesn't. */
export function skillCommand(request: string, skills: readonly Skill[] = SKILLS): SkillCommand | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(request.trim());
  if (!match) return null;
  const skill = skills.find((candidate) => candidate.name === match[1]!.toLowerCase());
  return skill ? { skill, rest: (match[2] ?? "").trim() } : { unknown: match[1]! };
}

/**
 * The Skills whose command starts as the Request does, while it is still a
 * bare command being typed (a slash and no space yet); none otherwise.
 */
export function skillSuggestions(request: string, skills: readonly Skill[] = SKILLS): Skill[] {
  const match = /^\/(\S*)$/.exec(request);
  if (!match) return [];
  const typed = match[1]!.toLowerCase();
  return skills.filter((skill) => skill.name.startsWith(typed));
}

/** What the model is sent for a Request made with `skill`, given what the musician typed after its command. */
export function skillRequest(skill: Skill, rest: string): string {
  return [
    `The musician used the Skill /${skill.name} (${skill.title}). Follow its instructions for this Request:`,
    "",
    skill.instructions,
    "",
    rest ? `What the musician added: ${rest}` : "The musician added nothing after the command.",
  ].join("\n");
}
