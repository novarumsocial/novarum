// A single Novarum per data dir. The first one listens on a loopback port it writes to the data
// dir; later launches knock on it to bring that window up, then exit.
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::OnceLock,
    time::Duration,
};

use super::{Action, Actions};

const HELLO: &[u8] = b"novarum\n";

static LISTENER: OnceLock<TcpListener> = OnceLock::new();

fn port_file() -> std::path::PathBuf {
    crate::storage::data_dir().join("instance-port")
}

/// Whether this launch should go on. False when another Novarum is already running; it was told
/// to show its window, unless this is a hidden (autostart) launch.
pub fn claim() -> bool {
    let running = std::fs::read_to_string(port_file())
        .ok()
        .and_then(|port| port.trim().parse().ok())
        .is_some_and(knock);
    if running {
        return false;
    }
    // without a listener there's no single instance, but Novarum still runs
    if let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        && let Ok(address) = listener.local_addr()
    {
        let _ = std::fs::write(port_file(), address.port().to_string());
        let _ = LISTENER.set(listener);
    }
    true
}

fn knock(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    // the port might have been reused by something else since Novarum last ran
    let mut hello = [0; HELLO.len()];
    if stream.read_exact(&mut hello).is_err() || hello != HELLO {
        return false;
    }
    let request: &[u8] = if super::launch_hidden() {
        b"\n"
    } else {
        b"show\n"
    };
    stream.write_all(request).is_ok()
}

pub fn listen(actions: Actions) {
    let Some(listener) = LISTENER.get() else {
        return;
    };
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let _ = stream.write_all(HELLO);
            let mut request = String::new();
            let _ = BufReader::new(&stream).read_line(&mut request);
            if request.trim() == "show" {
                let _ = actions.unbounded_send(Action::Show);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::{io::Write, net::TcpListener};

    #[test]
    fn knocking_on_something_else_is_not_a_running_novarum() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.write_all(b"SSH-2.0-OpenSSH\n");
        });
        assert!(!super::knock(port));
    }
}
