/**
 * Where each Track and Bus sends its signal. Every Track and Bus has one
 * output, the Master or a Bus, and any number of Sends, each to a Bus. Buses
 * may feed Buses, through outputs or Sends, but never in a loop: a command
 * that would make one is refused with the reason, and validation rejects a
 * Project that has one, so the Audio Engine never sees one.
 */
import type { Bus, Output, Project, Send } from "./model";

/** A new Send's level: unity, so it sends what leaves the fader. */
export const DEFAULT_SEND_LEVEL = 1;

/** Which mixer channel: a Track's or a Bus's. */
export type Channel = { trackId: string } | { busId: string };

export function findBus(project: Pick<Project, "buses">, busId: string): Bus | undefined {
  return project.buses.find((bus) => bus.id === busId);
}

/** What the musician calls an output: "the Master", or the Bus's name. */
export function outputName(project: Pick<Project, "buses">, output: Output): string {
  if (output === null) return "the Master";
  return findBus(project, output)?.name ?? `Bus ${output}`;
}

/**
 * The Buses a signal leaving through `output` passes on its way to the
 * Master, in order. Stops short if it loops, so it always ends.
 */
export function busesOnTheWay(project: Pick<Project, "buses">, output: Output): Bus[] {
  const way: Bus[] = [];
  let next = output;
  while (next !== null) {
    const bus = findBus(project, next);
    if (!bus || way.includes(bus)) break;
    way.push(bus);
    next = bus.output;
  }
  return way;
}

/** Something that feeds Buses: a Track or a Bus. */
interface Feeder {
  output: Output;
  sends: Send[];
}

/** The ids of every Bus `channel` feeds directly: its output's, then each Send's. */
export function feedsOf(channel: Feeder): string[] {
  return [...(channel.output === null ? [] : [channel.output]), ...channel.sends.map((send) => send.busId)];
}

/**
 * A way from Bus `from` to Bus `to` through outputs and Sends, as the Buses
 * it passes, `from` and `to` included, or null if the signal never gets
 * there.
 */
function wayBetween(project: Pick<Project, "buses">, from: Bus, to: Bus): Bus[] | null {
  const seen = new Set<string>();
  const search = (at: Bus): Bus[] | null => {
    if (at.id === to.id) return [at];
    if (seen.has(at.id)) return null;
    seen.add(at.id);
    for (const next of feedsOf(at)) {
      const bus = findBus(project, next);
      const way = bus && search(bus);
      if (way) return [at, ...way];
    }
    return null;
  };
  return search(from);
}

/**
 * Why `channel` can't feed Bus `output`, through its output or a Send, or
 * null if it can: the Bus must exist, and a Bus can't feed itself, directly
 * or through the Buses after it. `verb` says how, in the message.
 */
export function routingProblem(
  project: Pick<Project, "buses">,
  channel: Channel,
  output: Output,
  verb = "feed",
): string | null {
  if (output === null) return null;
  const target = findBus(project, output);
  if (!target) return `There is no Bus ${output}`;
  if (!("busId" in channel)) return null;
  const bus = findBus(project, channel.busId);
  if (!bus) return `There is no Bus ${channel.busId}`;
  if (target.id === bus.id) return `${bus.name} can't ${verb} itself`;
  const way = wayBetween(project, target, bus);
  if (!way) return null;
  const round = [bus, ...way].map((next) => next.name).join(" → ");
  return `${bus.name} can't ${verb} ${target.name}: the signal would go round in a loop (${round})`;
}

/**
 * Why `channel` can't have a Send to Bus `busId`, or null if it can: the
 * routing rules, and at most one Send from a channel to each Bus.
 */
export function sendProblem(project: Pick<Project, "tracks" | "buses">, channel: Channel, busId: string): string | null {
  const owner =
    "busId" in channel
      ? findBus(project, channel.busId)
      : project.tracks.find((track) => track.id === channel.trackId);
  const routing = routingProblem(project, channel, busId, "send to");
  if (routing) return routing;
  if (owner?.sends.some((send) => send.busId === busId)) {
    return `${owner.name} already sends to ${findBus(project, busId)?.name ?? busId}`;
  }
  return null;
}

/**
 * A loop in a Project's routing, through outputs or Sends, as the names of
 * the Buses in it, or null if there is none.
 */
export function routingLoop(project: Pick<Project, "buses">): string[] | null {
  const done = new Set<string>();
  const search = (bus: Bus, path: Bus[]): string[] | null => {
    const at = path.indexOf(bus);
    if (at >= 0) return [...path.slice(at), bus].map((each) => each.name);
    if (done.has(bus.id)) return null;
    for (const next of feedsOf(bus)) {
      const target = findBus(project, next);
      const loop = target && search(target, [...path, bus]);
      if (loop) return loop;
    }
    done.add(bus.id);
    return null;
  };
  for (const bus of project.buses) {
    const loop = search(bus, []);
    if (loop) return loop;
  }
  return null;
}

/**
 * The ids of the Tracks and Buses that can't be heard, as the Audio Engine
 * decides it. While anything is soloed, a channel is heard only if it is
 * soloed, feeds a soloed Bus, or is a Bus a soloed channel feeds, however
 * indirectly. A heard channel is still silent if it is muted, or if every
 * way it has to the Master, through outputs and Sends, passes a muted Bus.
 */
export function silencedChannels(project: Pick<Project, "tracks" | "buses">): Set<string> {
  const channels = [...project.tracks, ...project.buses];
  const soloing = channels.some((channel) => channel.mixer.solo);
  // Every Bus reachable from `channel`, however indirectly.
  const downstream = (channel: Feeder): Set<string> => {
    const reached = new Set<string>();
    const visit = (from: Feeder) => {
      for (const id of feedsOf(from)) {
        const bus = findBus(project, id);
        if (bus && !reached.has(bus.id)) {
          reached.add(bus.id);
          visit(bus);
        }
      }
    };
    visit(channel);
    return reached;
  };
  const fedBySolo = new Set<string>();
  for (const channel of channels) {
    if (channel.mixer.solo) for (const id of downstream(channel)) fedBySolo.add(id);
  }
  const reachesMaster = (channel: Feeder, seen: Set<string>): boolean =>
    channel.output === null ||
    feedsOf(channel).some((id) => {
      const bus = findBus(project, id);
      if (!bus || seen.has(bus.id) || bus.mixer.mute) return false;
      return reachesMaster(bus, new Set([...seen, bus.id]));
    });
  const silenced = new Set<string>();
  for (const channel of channels) {
    const feedsASolo = [...downstream(channel)].some((id) => findBus(project, id)?.mixer.solo);
    const heard = !soloing || channel.mixer.solo || fedBySolo.has(channel.id) || feedsASolo;
    if (!heard || channel.mixer.mute || !reachesMaster(channel, new Set([channel.id]))) silenced.add(channel.id);
  }
  return silenced;
}
