//! `soundcheck-relay`: serves a Relay on `HOST:PORT`, 0.0.0.0:8080 unless
//! they are set, with the default limits.

use std::net::SocketAddr;

use soundcheck_relay::{Limits, Relay};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let address: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let listener = TcpListener::bind(address).await?;
    eprintln!("Soundcheck Relay on {}", listener.local_addr()?);
    tokio::select! {
        served = Relay::new(Limits::default()).serve(listener) => served,
        () = stopped() => Ok(()),
    }
}

/// Ctrl+C, or the SIGTERM a container is stopped with.
async fn stopped() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
