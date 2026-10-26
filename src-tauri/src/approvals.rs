//! SSHホスト鍵の承認要求の管理簿。
//!
//! イベント通知だけに頼ると、フロントエンドの購読が済む前に出た要求を取りこぼす。
//! 未応答の要求をここに保持し、後から問い合わせて取り込めるようにする。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tokio::sync::oneshot;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyRequest {
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

type Entry = (u64, HostKeyRequest, oneshot::Sender<bool>);

#[derive(Debug, Default)]
pub struct ApprovalBook {
    entries: Mutex<HashMap<String, Entry>>,
    next: AtomicU64,
}

impl ApprovalBook {
    // ロックの毒化は保持データの整合性を壊さないため無視してよい。
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 要求を登録し、応答を待つ受信側を返す。
    pub fn register(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> (HostKeyRequest, oneshot::Receiver<bool>) {
        let seq = self.next.fetch_add(1, Ordering::Relaxed);
        let request = HostKeyRequest {
            request_id: format!("hostkey-{seq}"),
            host: host.to_owned(),
            port,
            fingerprint: fingerprint.to_owned(),
        };
        let (tx, rx) = oneshot::channel();
        self.entries()
            .insert(request.request_id.clone(), (seq, request.clone(), tx));
        (request, rx)
    }

    /// 応答を渡す。要求が存在しない（期限切れ・応答済み）なら `false`。
    pub fn respond(&self, request_id: &str, approved: bool) -> bool {
        match self.entries().remove(request_id) {
            Some((_, _, tx)) => {
                // 待ち側が既にいなくても、要求の消費としては成功扱いにする。
                let _ = tx.send(approved);
                true
            }
            None => false,
        }
    }

    /// 応答待ちを取り下げる（タイムアウト・送信失敗時）。
    pub fn cancel(&self, request_id: &str) {
        self.entries().remove(request_id);
    }

    /// 未応答の要求を登録順に返す。
    pub fn pending(&self) -> Vec<HostKeyRequest> {
        let entries = self.entries();
        let mut all: Vec<_> = entries
            .values()
            .map(|(seq, req, _)| (*seq, req.clone()))
            .collect();
        all.sort_by_key(|(seq, _)| *seq);
        all.into_iter().map(|(_, req)| req).collect()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn registered_request_is_pending_until_answered() {
        let book = ApprovalBook::default();
        let (req, _rx) = book.register("example.com", 22, "SHA256:abc");
        assert_eq!(req.host, "example.com");
        assert_eq!(req.port, 22);
        assert_eq!(req.fingerprint, "SHA256:abc");
        assert_eq!(book.pending(), vec![req.clone()]);
        assert!(book.respond(&req.request_id, true));
        assert!(book.pending().is_empty());
    }

    #[tokio::test]
    async fn respond_delivers_the_answer_to_the_waiter() {
        let book = ApprovalBook::default();
        let (a, rx_a) = book.register("a", 22, "fp-a");
        let (b, rx_b) = book.register("b", 22, "fp-b");
        assert!(book.respond(&a.request_id, true));
        assert!(book.respond(&b.request_id, false));
        assert!(rx_a.await.unwrap());
        assert!(!rx_b.await.unwrap());
    }

    #[test]
    fn respond_to_unknown_or_answered_request_returns_false() {
        let book = ApprovalBook::default();
        assert!(!book.respond("nope", true));
        let (req, _rx) = book.register("h", 22, "fp");
        assert!(book.respond(&req.request_id, true));
        assert!(!book.respond(&req.request_id, true));
    }

    #[test]
    fn cancel_removes_the_request() {
        let book = ApprovalBook::default();
        let (req, _rx) = book.register("h", 22, "fp");
        book.cancel(&req.request_id);
        assert!(book.pending().is_empty());
        assert!(!book.respond(&req.request_id, true));
        book.cancel("unknown"); // 存在しなくても問題ない
    }

    #[test]
    fn pending_is_in_registration_order_with_unique_ids() {
        let book = ApprovalBook::default();
        let hosts: Vec<String> = (0..12).map(|i| format!("h{i}")).collect();
        let ids: std::collections::HashSet<_> = hosts
            .iter()
            .map(|h| book.register(h, 22, "fp").0.request_id)
            .collect();
        assert_eq!(ids.len(), hosts.len());
        let order: Vec<String> = book.pending().into_iter().map(|r| r.host).collect();
        assert_eq!(order, hosts);
    }

    #[test]
    fn concurrent_registration_keeps_every_request() {
        let book = Arc::new(ApprovalBook::default());
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let book = book.clone();
                std::thread::spawn(move || {
                    drop(book.register(&format!("h{i}"), 22, "fp"));
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        // 受信側はスレッド終了時にドロップされるが、要求は応答/取り下げまで残る。
        assert_eq!(book.pending().len(), 16);
    }

    #[test]
    fn request_serializes_in_camel_case() {
        let req = HostKeyRequest {
            request_id: "r".into(),
            host: "h".into(),
            port: 22,
            fingerprint: "fp".into(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["requestId"], "r");
        assert_eq!(json["fingerprint"], "fp");
    }
}
