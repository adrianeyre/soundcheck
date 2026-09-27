//! The Relay as its members see it: real WebSockets to a Relay on a port of
//! its own.

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use soundcheck_relay::{Limits, Relay};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{Bytes, Error, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SESSION: &str = "Zm9vYmFyYmF6cXV4cXV1eA";
const OTHER: &str = "b3RoZXJzZXNzaW9uaWQxMg";

async fn relay(limits: Limits) -> (Relay, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let relay = Relay::new(limits);
    tokio::spawn(relay.clone().serve(listener));
    (relay, format!("ws://{address}"))
}

async fn member(at: &str, session: &str) -> Socket {
    connect_async(format!("{at}/session/{session}"))
        .await
        .unwrap()
        .0
}

/// The next binary frame, skipping pings, or None if there isn't one soon.
async fn next_frame(socket: &mut Socket) -> Option<Vec<u8>> {
    loop {
        match timeout(Duration::from_millis(500), socket.next()).await {
            Ok(Some(Ok(Message::Binary(bytes)))) => return Some(bytes.to_vec()),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
            _ => return None,
        }
    }
}

/// Whether the Relay ends the connection within a second.
async fn ended(socket: &mut Socket) -> bool {
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        let read = timeout(Duration::from_millis(100), socket.next()).await;
        if let Ok(None | Some(Ok(Message::Close(_)) | Err(_))) = read {
            return true;
        }
    }
    false
}

/// Waits for the Relay to have seen every member join or leave.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

fn binary(bytes: &[u8]) -> Message {
    Message::Binary(Bytes::copy_from_slice(bytes))
}

#[tokio::test]
async fn a_frame_reaches_everyone_else_in_the_session_and_no_one_outside_it() {
    let (_relay, at) = relay(Limits::default()).await;
    let mut alice = member(&at, SESSION).await;
    let mut bob = member(&at, SESSION).await;
    let mut sam = member(&at, SESSION).await;
    let mut elsewhere = member(&at, OTHER).await;
    settle().await;

    alice.send(binary(b"a Change")).await.unwrap();
    assert_eq!(
        next_frame(&mut bob).await.as_deref(),
        Some(&b"a Change"[..])
    );
    assert_eq!(
        next_frame(&mut sam).await.as_deref(),
        Some(&b"a Change"[..])
    );
    // Not back to Alice, and not to another session.
    assert_eq!(next_frame(&mut alice).await, None);
    assert_eq!(next_frame(&mut elsewhere).await, None);
}

#[tokio::test]
async fn frames_arrive_in_the_order_they_were_sent() {
    let (_relay, at) = relay(Limits::default()).await;
    let mut alice = member(&at, SESSION).await;
    let mut bob = member(&at, SESSION).await;
    settle().await;
    for index in 0u8..20 {
        alice.send(binary(&[index])).await.unwrap();
    }
    for index in 0u8..20 {
        assert_eq!(next_frame(&mut bob).await, Some(vec![index]));
    }
}

#[tokio::test]
async fn a_session_is_gone_once_its_last_member_leaves() {
    let (relay, at) = relay(Limits::default()).await;
    let alice = member(&at, SESSION).await;
    let bob = member(&at, OTHER).await;
    settle().await;
    assert_eq!(relay.sessions(), 2);
    drop(alice);
    drop(bob);
    settle().await;
    assert_eq!(relay.sessions(), 0);
}

#[tokio::test]
async fn a_frame_over_the_size_limit_ends_the_senders_connection_and_goes_nowhere() {
    let (_relay, at) = relay(Limits {
        frame: 1024,
        ..Limits::default()
    })
    .await;
    let mut alice = member(&at, SESSION).await;
    let mut bob = member(&at, SESSION).await;
    settle().await;

    alice.send(binary(&[0; 1024])).await.unwrap();
    assert_eq!(
        next_frame(&mut bob).await.map(|frame| frame.len()),
        Some(1024)
    );
    let _ = alice.send(binary(&[0; 1025])).await;
    assert!(ended(&mut alice).await);
    assert_eq!(next_frame(&mut bob).await, None);
}

#[tokio::test]
async fn text_frames_are_refused_as_the_relay_only_passes_encrypted_bytes() {
    let (_relay, at) = relay(Limits::default()).await;
    let mut alice = member(&at, SESSION).await;
    let mut bob = member(&at, SESSION).await;
    settle().await;
    alice
        .send(Message::text("a song, in the clear"))
        .await
        .unwrap();
    assert!(ended(&mut alice).await);
    assert_eq!(next_frame(&mut bob).await, None);
}

#[tokio::test]
async fn a_full_session_turns_one_more_member_away() {
    let (_relay, at) = relay(Limits {
        members: 2,
        ..Limits::default()
    })
    .await;
    let _alice = member(&at, SESSION).await;
    let _bob = member(&at, SESSION).await;
    let refused = connect_async(format!("{at}/session/{SESSION}")).await;
    assert!(
        matches!(&refused, Err(Error::Http(response)) if response.status() == 403),
        "{refused:?}"
    );
    // Another session still has room.
    let _elsewhere = member(&at, OTHER).await;
}

#[tokio::test]
async fn a_full_relay_turns_one_more_member_away_until_one_leaves() {
    let (_relay, at) = relay(Limits {
        connections: 1,
        ..Limits::default()
    })
    .await;
    let alice = member(&at, SESSION).await;
    let refused = connect_async(format!("{at}/session/{OTHER}")).await;
    assert!(
        matches!(&refused, Err(Error::Http(response)) if response.status() == 503),
        "{refused:?}"
    );
    drop(alice);
    settle().await;
    let _bob = member(&at, OTHER).await;
}

#[tokio::test]
async fn a_session_id_an_invite_link_could_not_have_made_is_not_found() {
    let (_relay, at) = relay(Limits::default()).await;
    let refused = connect_async(format!("{at}/session/short")).await;
    assert!(
        matches!(&refused, Err(Error::Http(response)) if response.status() == 404),
        "{refused:?}"
    );
}

#[tokio::test]
async fn a_member_sending_faster_than_the_rate_is_slowed_and_loses_nothing() {
    // 64 KiB at once, then 256 KiB a second.
    let (_relay, at) = relay(Limits {
        rate: 256 * 1024,
        burst: 64 * 1024,
        ..Limits::default()
    })
    .await;
    let mut alice = member(&at, SESSION).await;
    let mut bob = member(&at, SESSION).await;
    settle().await;

    let started = Instant::now();
    let sending = tokio::spawn(async move {
        for index in 0u8..8 {
            alice.send(binary(&[index; 32 * 1024])).await.unwrap();
        }
        alice
    });
    for index in 0u8..8 {
        let frame = next_frame(&mut bob).await.expect("every frame arrives");
        assert_eq!((frame[0], frame.len()), (index, 32 * 1024));
    }
    // 256 KiB, less the 64 KiB burst, at 256 KiB a second.
    assert!(
        started.elapsed() >= Duration::from_millis(600),
        "{:?}",
        started.elapsed()
    );
    drop(sending.await.unwrap());
}

#[tokio::test]
async fn it_answers_a_health_check() {
    let (_relay, at) = relay(Limits::default()).await;
    let address = at.trim_start_matches("ws://");
    let mut stream = TcpStream::connect(address).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream
        .write_all(
            format!("GET / HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.ends_with("Soundcheck Relay\n"), "{response}");
}

#[tokio::test]
async fn a_member_too_far_behind_is_let_go_and_the_rest_carry_on() {
    // Alice sends 16 MiB a second; Sam keeps up and Bob takes nothing,
    // until more is waiting for him than the backlog and the network
    // between them hold.
    let (_relay, at) = relay(Limits {
        backlog: 8,
        rate: 16 * 1024 * 1024,
        burst: 1024 * 1024,
        ..Limits::default()
    })
    .await;
    let mut alice = member(&at, SESSION).await;
    let mut bob = member(&at, SESSION).await;
    let mut sam = member(&at, SESSION).await;
    settle().await;
    const FRAMES: usize = 256;
    let reading = tokio::spawn(async move {
        let mut got = 0;
        while got < FRAMES && next_frame(&mut sam).await.is_some() {
            got += 1;
        }
        got
    });
    let frame = vec![7; 128 * 1024];
    for _ in 0..FRAMES {
        alice.send(binary(&frame)).await.unwrap();
    }
    assert_eq!(reading.await.unwrap(), FRAMES);

    let closed = loop {
        match timeout(Duration::from_secs(5), bob.next()).await {
            Ok(Some(Ok(Message::Close(close)))) => break close,
            Ok(Some(Ok(_))) => {}
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(closed.map(|close| u16::from(close.code)), Some(1013));
}
