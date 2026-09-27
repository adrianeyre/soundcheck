import { useId, useState } from "react";

import type { ProjectHistory } from "../project/history";
import { setTypedRelay, setYourName, typedRelay, yourName } from "./identity";
import { relayAddress } from "./live-wire";

/**
 * The name this person's Changes carry, so a Collaborator's notices can say
 * who changed what: "Undo of “Add Track” left “Bass” as Sam changed it since".
 * And the Relay their Live Sessions go through, if not the one Soundcheck was
 * built with.
 */
export function CollaborationSettings({ history }: { history: ProjectHistory }) {
  const [name, setName] = useState(() => yourName() ?? "");
  const [relay, setRelay] = useState(typedRelay);
  const help = useId();
  const relayHelp = useId();
  const built = relayAddress(import.meta.env.VITE_RELAY_URL ?? "");
  const invalid = relay.trim() !== "" && !relayAddress(relay);
  return (
    <div className="stack">
      <label className="field">
        Your name
        <input
          value={name}
          autoComplete="name"
          aria-describedby={help}
          onChange={(event) => {
            setName(event.target.value);
            setYourName(event.target.value);
            history.signAs(event.target.value);
          }}
        />
      </label>
      <p id={help} className="hint">
        Kept on this machine. Anyone you share a Project with sees it on your Changes from now on.
      </p>
      <label className="field">
        Relay address
        <input
          value={relay}
          placeholder={built ?? "wss://relay.example.com"}
          spellCheck={false}
          aria-describedby={relayHelp}
          aria-invalid={invalid}
          onChange={(event) => {
            setRelay(event.target.value);
            setTypedRelay(event.target.value);
          }}
        />
      </label>
      <p id={relayHelp} className="hint">
        {invalid
          ? "That isn't a Relay's address. It looks like wss://relay.example.com."
          : built
            ? `Live Sessions you start go through ${built}. To use a Relay of your own, type its address.`
            : "A Live Session needs a Relay to pass everyone's Changes between them. This copy of Soundcheck came without one: type the address of one you or a friend run."}{" "}
        It passes on only what it can't read, and keeps none of it. Whoever joins from your invite link uses the same one.
      </p>
    </div>
  );
}
