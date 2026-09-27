// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { ProjectHistory } from "../project/history";
import { createProject } from "../project/model";
import type { StartConversation } from "./assistant";
import { memoryKeyStore } from "./key-store";
import { RequestBox } from "./RequestBox";
import type { Skill } from "./skills";

afterEach(cleanup);

const SKILLS: Skill[] = [
  { name: "build-up", title: "Build-up", category: "Arrangement", description: "Build into a Section.", argumentHint: "[Section]", instructions: "Add a snare roll." },
  { name: "drum-beat", title: "Drum beat", category: "Drums", description: "Program a beat.", argumentHint: "", instructions: "Add a Drum Track." },
  { name: "fix-clipping", title: "Fix clipping", category: "Mixing", description: "Bring the peak down.", argumentHint: "", instructions: "Analyse the mix." },
];

/** A model that answers every Request at once, and remembers what each was sent. */
function show({ key = "sk-test" }: { key?: string | null } = {}) {
  const sent: string[] = [];
  const conversations = (): StartConversation => (request) => {
    sent.push(request);
    return { next: () => Promise.resolve({ text: "Done.", toolCalls: [] }) };
  };
  render(
    <RequestBox
      history={new ProjectHistory(createProject("Demo"))}
      keyStore={key ? memoryKeyStore(key) : memoryKeyStore()}
      conversations={conversations}
      skills={SKILLS}
    />,
  );
  return sent;
}

const prompt = () => screen.findByRole("combobox", { name: "Request" });
const shownSkill = () => within(screen.getByRole("dialog", { name: "Skills" })).getByRole("article");

test("View skills shows one Skill at a time; Previous and Next go round, and the cross closes it", async () => {
  show({ key: null });
  const view = await screen.findByRole("button", { name: "View skills" });
  view.focus();
  fireEvent.click(view);
  const dialog = screen.getByRole("dialog", { name: "Skills" });
  expect(shownSkill()).toHaveAccessibleName("Build-up");
  expect(within(dialog).getByText("/build-up")).toBeInTheDocument();
  expect(within(dialog).getByText("Add a snare roll.")).toBeInTheDocument();
  expect(within(dialog).getByText("1 of 3")).toBeInTheDocument();
  // No model yet, so no Request can start from it.
  expect(within(dialog).queryByRole("button", { name: /^Use / })).not.toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
  expect(shownSkill()).toHaveAccessibleName("Drum beat");
  expect(within(dialog).getByText("2 of 3")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Previous" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Previous" }));
  expect(shownSkill()).toHaveAccessibleName("Fix clipping");
  fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
  expect(shownSkill()).toHaveAccessibleName("Build-up");

  fireEvent.click(within(dialog).getByRole("button", { name: "Close skills" }));
  expect(screen.queryByRole("dialog", { name: "Skills" })).not.toBeInTheDocument();
  expect(view).toHaveFocus();
});

test("Category narrows the Skills to one kind, which Previous and Next keep to, and Skill jumps to one", async () => {
  show({ key: null });
  fireEvent.click(await screen.findByRole("button", { name: "View skills" }));
  const dialog = screen.getByRole("dialog", { name: "Skills" });
  const category = within(dialog).getByRole("combobox", { name: "Category" });
  expect(within(category).getAllByRole("option").map((option) => option.textContent)).toEqual([
    "All (3)",
    "Drums (1)",
    "Arrangement (1)",
    "Mixing (1)",
  ]);

  fireEvent.change(category, { target: { value: "Mixing" } });
  expect(shownSkill()).toHaveAccessibleName("Fix clipping");
  expect(within(dialog).getByText("1 of 1")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();

  fireEvent.change(category, { target: { value: "all" } });
  expect(within(dialog).getByText("1 of 3")).toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Skill" }), { target: { value: "fix-clipping" } });
  expect(shownSkill()).toHaveAccessibleName("Fix clipping");
  expect(within(dialog).getByText("3 of 3")).toBeInTheDocument();
});

test("Use starts a Request with the Skill's command, and the prompt takes focus", async () => {
  show();
  const input = await prompt();
  fireEvent.click(screen.getByRole("button", { name: "View skills" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Use /drum-beat" }));
  expect(screen.queryByRole("dialog", { name: "Skills" })).not.toBeInTheDocument();
  expect(input).toHaveValue("/drum-beat ");
  expect(input).toHaveFocus();
  expect(screen.getByText(/Using the Skill/)).toHaveTextContent("Using the Skill Drum beat");
});

test("typing a slash lists the Skills that match; the arrows choose one and Enter completes it", async () => {
  show();
  const input = await prompt();
  fireEvent.change(input, { target: { value: "/" } });
  expect(input).toHaveAttribute("aria-expanded", "true");
  const list = screen.getByRole("listbox", { name: "Skills" });
  expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual([
    "/build-upBuild into a Section.",
    "/drum-beatProgram a beat.",
    "/fix-clippingBring the peak down.",
  ]);
  expect(within(list).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(input, { key: "ArrowUp" });
  const last = within(list).getAllByRole("option")[2]!;
  expect(last).toHaveAttribute("aria-selected", "true");
  expect(input).toHaveAttribute("aria-activedescendant", last.id);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("/fix-clipping ");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

  // Narrowed by what is typed, and closed by Escape until the next keystroke.
  fireEvent.change(input, { target: { value: "/d" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "/dr" } });
  fireEvent.click(screen.getByRole("option", { name: /drum-beat/ }));
  expect(input).toHaveValue("/drum-beat ");
});

test("a Skill's Request is sent as its instructions, and the transcript shows what was typed", async () => {
  const sent = show();
  fireEvent.change(await prompt(), { target: { value: "/build-up into the chorus" } });
  expect(screen.getByText(/Using the Skill/)).toHaveTextContent("Using the Skill Build-up: add [Section] after the command");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toContain("Skill /build-up (Build-up)");
  expect(sent[0]).toContain("Add a snare roll.");
  expect(sent[0]).toContain("What the musician added: into the chorus");
  expect(await screen.findByLabelText("What you asked")).toHaveTextContent("/build-up into the chorus");
});

test("a command no Skill has can't be sent, and says where the Skills are", async () => {
  const sent = show();
  const input = await prompt();
  fireEvent.change(input, { target: { value: "/mastering loud" } });
  expect(screen.getByText(/There's no Skill called/)).toHaveTextContent("There's no Skill called /mastering. View skills lists them.");
  expect(input).toHaveAccessibleDescription(/There's no Skill called \/mastering/);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

  // A Request that doesn't start with a slash goes as it is.
  fireEvent.change(input, { target: { value: "add a kick" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sent).toEqual(["add a kick"]));
});
