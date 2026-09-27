//! The Soundcheck Relay (ADR 0007): the members of a Live Session connect to
//! `/session/<id>` over a WebSocket, and every binary frame one of them sends
//! is passed to all the others in that session, as it comes.
//!
//! That is all it does. Frames are encrypted by the members with a key the
//! Relay never sees, so it can't read them, and it keeps none: a member who
//! joins late catches up from the others, not from here. What it does keep
//! to is a size limit on each frame, a rate limit on each member, a limit on
//! how many members a session and the whole Relay may have, and a backlog
//! beyond which a member too slow to take what the session sends is let go,
//! to reconnect and catch up.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, sleep_until};

/// What the Relay allows, for one member, one session and all of them.
#[derive(Clone, Debug)]
pub struct Limits {
    /// The largest frame a member may send, in bytes. A larger one ends
    /// that member's connection. Members split what is larger.
    pub frame: usize,
    /// How many bytes a second one member may send, on average. Past that,
    /// the Relay reads from them more slowly, so they wait: nothing is lost.
    pub rate: u64,
    /// How many bytes a member may send at once before the rate applies.
    pub burst: u64,
    /// How many members one session may have.
    pub members: usize,
    /// How many members the whole Relay may have, over every session.
    pub connections: usize,
    /// How many frames a session holds for a member that hasn't taken them
    /// yet. A member further behind than that is let go.
    pub backlog: usize,
    /// How often each member is pinged, so proxies keep a quiet connection
    /// open.
    pub ping: Duration,
}

const MIB: usize = 1024 * 1024;

impl Default for Limits {
    fn default() -> Self {
        Self {
            frame: MIB,
            rate: 2 * MIB as u64,
            burst: 8 * MIB as u64,
            members: 16,
            connections: 2000,
            backlog: 64,
            ping: Duration::from_secs(20),
        }
    }
}

/// Each member of a session, by id, and where frames for them wait.
struct Session {
    members: HashMap<u64, mpsc::Sender<Bytes>>,
}

struct Inner {
    limits: Limits,
    sessions: Mutex<HashMap<String, Session>>,
    next_member: AtomicU64,
}

/// A Relay: clone it freely, every clone is the same one.
#[derive(Clone)]
pub struct Relay {
    inner: Arc<Inner>,
}

impl Relay {
    pub fn new(limits: Limits) -> Self {
        Self {
            inner: Arc::new(Inner {
                limits,
                sessions: Mutex::new(HashMap::new()),
                next_member: AtomicU64::new(0),
            }),
        }
    }

    /// `/` says what this is, as a health check; `/session/<id>` is a session.
    pub fn router(&self) -> Router {
        Router::new()
            .route("/", get(|| async { "Soundcheck Relay\n" }))
            .route("/session/{id}", get(join))
            .with_state(self.clone())
    }

    /// Serve on `listener` until the process ends.
    pub async fn serve(self, listener: TcpListener) -> io::Result<()> {
        axum::serve(listener, self.router()).await
    }

    /// How many sessions have a member now.
    pub fn sessions(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        // Nothing holding the lock can panic halfway through a change, so a
        // poisoned map is still whole.
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// A place in session `id`, if it and the Relay have room.
    fn admit(&self, id: &str) -> Result<Membership, (StatusCode, &'static str)> {
        let limits = &self.inner.limits;
        let mut sessions = self.lock();
        let everyone: usize = sessions.values().map(|session| session.members.len()).sum();
        if everyone >= limits.connections {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "This Relay is full. Try again later.",
            ));
        }
        let session = sessions.entry(id.to_owned()).or_insert_with(|| Session {
            members: HashMap::new(),
        });
        if session.members.len() >= limits.members {
            return Err((StatusCode::FORBIDDEN, "This Live Session is full."));
        }
        let member = self.inner.next_member.fetch_add(1, Ordering::Relaxed);
        let (sender, frames) = mpsc::channel(limits.backlog);
        session.members.insert(member, sender);
        Ok(Membership {
            relay: self.clone(),
            session: id.to_owned(),
            member,
            frames,
        })
    }

    /// Pass a member's frame to everyone else in their session. A member
    /// whose backlog is full is let go: their queue closes once they have
    /// taken what is in it.
    fn pass(&self, session: &str, from: u64, frame: &Bytes) {
        if let Some(session) = self.lock().get_mut(session) {
            session
                .members
                .retain(|&member, queue| member == from || queue.try_send(frame.clone()).is_ok());
        }
    }
}

/// A member's place in a session, given up when it is dropped: when the
/// connection ends, or if it never opens.
struct Membership {
    relay: Relay,
    session: String,
    member: u64,
    /// Other members' frames, waiting to be sent to this one.
    frames: mpsc::Receiver<Bytes>,
}

impl Drop for Membership {
    fn drop(&mut self) {
        let mut sessions = self.relay.lock();
        if let Some(session) = sessions.get_mut(&self.session) {
            session.members.remove(&self.member);
            if session.members.is_empty() {
                sessions.remove(&self.session);
            }
        }
    }
}

/// A session id is what the invite link made at random: 16 to 64 of the
/// characters base64url uses.
fn valid_session(id: &str) -> bool {
    (16..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

async fn join(
    State(relay): State<Relay>,
    Path(id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !valid_session(&id) {
        return (StatusCode::NOT_FOUND, "No such session.").into_response();
    }
    let membership = match relay.admit(&id) {
        Ok(membership) => membership,
        Err(refused) => return refused.into_response(),
    };
    let frame = relay.inner.limits.frame;
    upgrade
        .max_message_size(frame)
        .max_frame_size(frame)
        .on_upgrade(move |socket| member(socket, membership))
}

/// Why the Relay ended a member's connection, as its close frame says.
type Closing = Option<(u16, &'static str)>;

async fn member(socket: WebSocket, mut membership: Membership) {
    let limits = membership.relay.inner.limits.clone();
    let (mut sink, mut stream) = socket.split();
    let mut bucket = Bucket::new(limits.rate, limits.burst);
    let mut ping = interval(limits.ping);
    ping.reset();

    let closing: Closing = loop {
        let ready = bucket.ready();
        let limited = ready > Instant::now();
        tokio::select! {
            () = sleep_until(ready), if limited => {}
            read = stream.next(), if !limited => match read {
                Some(Ok(Message::Binary(bytes))) => {
                    bucket.spend(bytes.len());
                    membership.relay.pass(&membership.session, membership.member, &bytes);
                }
                Some(Ok(Message::Text(_))) => {
                    break Some((close_code::UNSUPPORTED, "The Relay only passes binary frames."));
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                // A frame over the size limit is an error too.
                Some(Ok(Message::Close(_)) | Err(_)) | None => break None,
            },
            frame = membership.frames.recv() => match frame {
                Some(bytes) => {
                    if sink.send(Message::Binary(bytes)).await.is_err() {
                        break None;
                    }
                }
                // Only a member too far behind has their queue closed.
                None => {
                    break Some((close_code::AGAIN, "Too far behind the session. Reconnect to catch up."));
                }
            },
            _ = ping.tick() => {
                if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                    break None;
                }
            }
        }
    };
    if let Some((code, reason)) = closing {
        let close = CloseFrame {
            code,
            reason: reason.into(),
        };
        let _ = sink.send(Message::Close(Some(close))).await;
    }
}

/// A token bucket: `burst` bytes at once, then `rate` a second.
struct Bucket {
    rate: f64,
    burst: f64,
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new(rate: u64, burst: u64) -> Self {
        Self {
            rate: rate as f64,
            burst: burst as f64,
            tokens: burst as f64,
            at: Instant::now(),
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        self.tokens = (self.tokens + (now - self.at).as_secs_f64() * self.rate).min(self.burst);
        self.at = now;
    }

    fn spend(&mut self, bytes: usize) {
        self.refill();
        self.tokens -= bytes as f64;
    }

    /// When the member may send again: now, unless they are in debt.
    fn ready(&mut self) -> Instant {
        self.refill();
        if self.tokens >= 0.0 {
            self.at
        } else {
            self.at + Duration::from_secs_f64(-self.tokens / self.rate)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_id_is_what_an_invite_link_makes() {
        assert!(valid_session("Zm9vYmFyYmF6cXV4cXV1eA"));
        assert!(!valid_session("short"));
        assert!(!valid_session("has/a/slash/in/it/somewhere"));
        assert!(!valid_session(&"a".repeat(65)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_member_past_their_burst_waits_as_long_as_the_rate_says() {
        let mut bucket = Bucket::new(1000, 500);
        bucket.spend(500);
        assert_eq!(bucket.ready(), Instant::now());
        bucket.spend(1500);
        let wait = bucket.ready() - Instant::now();
        assert!((wait.as_secs_f64() - 1.5).abs() < 0.01, "{wait:?}");
    }
}
