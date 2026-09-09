#!/usr/bin/env python3
"""Unit tests for lane_ctl pure-logic components (no root, no netns required)."""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))


def load_module():
    spec = importlib.util.spec_from_file_location(
        "lane_ctl", os.path.join(HERE, "lane_ctl.py"))
    mod = importlib.util.module_from_spec(spec)
    with mock.patch.dict(os.environ, {"LANE_TOKEN": "test-token"}):
        spec.loader.exec_module(mod)
    return mod


class BlacklistTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load_module()

    def test_exact_ipv4_match(self):
        self.assertTrue(self.m.ip_in_blacklist("45.132.194.7", ["45.132.194.7"]))

    def test_exact_ipv6_match(self):
        self.assertTrue(self.m.ip_in_blacklist(
            "2a01::1", ["2001:db8::/32", "2a01::1"]))

    def test_cidr_v4_match(self):
        self.assertTrue(self.m.ip_in_blacklist(
            "185.212.149.33", ["185.212.149.0/24"]))

    def test_cidr_no_cross_family_false_positive(self):
        # ::ffff:185.212.149.33 is IPv6; must not match an IPv4 CIDR.
        self.assertFalse(self.m.ip_in_blacklist(
            "::ffff:185.212.149.33", ["185.212.149.0/24"]))

    def test_malformed_entries_ignored(self):
        self.assertFalse(self.m.ip_in_blacklist("8.8.8.8", ["not-an-ip", "", "300.1.1.1"]))

    def test_empty_blacklist(self):
        self.assertFalse(self.m.ip_in_blacklist("1.2.3.4", []))


class StateStoreTest(unittest.TestCase):
    def setUp(self):
        self.m = load_module()
        self.tmp = tempfile.mkdtemp()
        self.store = self.m.StateStore(self.tmp, ["8001", "8002"])

    def test_counters_persist_and_reset_by_date(self):
        n = self.store.bump_rotation("8001")
        self.assertEqual(n, 1)
        self.assertEqual(self.store.rotations_today("8001"), 1)

        # Reload from disk -> counter survives restart on the same date.
        store2 = self.m.StateStore(self.tmp, ["8001", "8002"])
        self.assertEqual(store2.rotations_today("8001"), 1)
        store2.bump_rotation("8001")
        self.assertEqual(store2.rotations_today("8001"), 2)

        # Simulate a different UTC day -> counters reset.
        store2.counter_date = "2000-01-01"
        store2.save()
        store3 = self.m.StateStore(self.tmp, ["8001", "8002"])
        self.assertEqual(store3.rotations_today("8001"), 0)

    def test_running_jobs_marked_interrupted_on_restart(self):
        job = {"job_id": "rot-ab12", "port": "8001", "state": "running",
               "attempts": 1, "assigned_ip": None, "error": None}
        self.store.save_job(job)
        self.store.mark_running_jobs_interrupted()
        loaded = self.store.load_job("rot-ab12")
        self.assertEqual(loaded["state"], "failed")
        self.assertEqual(loaded["error"], "control_plane_restarted")

    def test_job_id_path_sanitized(self):
        path = self.store.job_path("../../etc/passwd")
        self.assertTrue(path.startswith(os.path.join(self.tmp, "jobs")))
        self.assertNotIn("..", os.path.basename(path))

    def test_failed_candidate_ttl_pruned(self):
        self.store.add_failed_candidate("8001", "srv-a")
        self.assertIn("srv-a", self.store.recent_failures("8001"))
        # Age out the entry manually.
        self.store.data["8001"]["failed_candidates"]["srv-a"] = 0
        self.assertNotIn("srv-a", self.store.recent_failures("8001"))


class AllowlistTest(unittest.TestCase):
    def test_allowlist_matches_base_and_path(self):
        m = load_module()
        with mock.patch.object(m, "ALLOWLIST", ["wg", "ip", "curl"]):
            self.assertTrue(m.cmd_allowed("wg show wg1"))
            self.assertTrue(m.cmd_allowed("/usr/sbin/wg show"))
            self.assertTrue(m.cmd_allowed("ip netns exec wg1 wg show"))
            self.assertFalse(m.cmd_allowed("bash -lc evil"))
            self.assertFalse(m.cmd_allowed("rm -rf /"))

    def test_unrestricted_when_empty(self):
        m = load_module()
        with mock.patch.object(m, "ALLOWLIST", []):
            self.assertTrue(m.cmd_allowed("anything --args"))


class WgConfTest(unittest.TestCase):
    def test_conf_shape(self):
        m = load_module()
        text = m.wg_conf_text("PRIVKEY=", "10.5.0.2/32", None,
                              "SRVPUB=", "123.45.67.89", 51820)
        self.assertIn("[Interface]", text)
        self.assertIn("PrivateKey = PRIVKEY=", text)
        self.assertIn("Endpoint = 123.45.67.89:51820", text)
        self.assertIn("AllowedIPs = 0.0.0.0/0,::/0", text)
        self.assertNotIn("DNS =", text)  # DNS handled by netns resolv.conf


class RunCmdTest(unittest.TestCase):
    def setUp(self):
        self.m = load_module()
        self.tmp = tempfile.mkdtemp()
        # redirect audit log into tmp dir
        patcher = mock.patch.object(self.m, "AUDIT_LOG",
                                    os.path.join(self.tmp, "audit.log"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_simple_exec(self):
        r = self.m.run_cmd("echo hello", 5000)
        self.assertEqual(r.exit_code, 0)
        self.assertEqual(r.stdout.strip(), "hello")
        self.assertFalse(r.timed_out)

    def test_timeout_kills_process_group(self):
        # Child spawns a sub-child; group kill must reap both and return fast.
        r = self.m.run_cmd("sleep 30 & sleep 30", 300)
        self.assertTrue(r.timed_out)
        self.assertLess(r.duration_ms, 3000)

    def test_output_bounded(self):
        r = self.m.run_cmd("python3 -c \"print('x'*(1024*1024))\"", 15000)
        self.assertLessEqual(len(r.stdout), self.m.MAX_OUTPUT_BYTES + 32)

    def test_audit_log_written_without_token(self):
        self.m.run_cmd("true", 2000)
        with open(os.path.join(self.tmp, "audit.log")) as f:
            rec = json.loads(f.readlines()[-1])
        self.assertIn("cmd", rec)
        self.assertIn("principal", rec)  # token hash, not the token
        self.assertNotIn("test-token", json.dumps(rec))


class PrevalidateProbeTest(unittest.TestCase):
    def setUp(self):
        self.m = load_module()

    def _probe(self, chat_rc=0, responses_rc=0, surfaces=None):
        calls = []

        def fake_sh(args, timeout=30):
            calls.append(args)
            url = args[6] if len(args) > 6 else ""
            if url.endswith("/responses"):
                return responses_rc, "", ""
            return chat_rc, "", ""

        surface_list = list(surfaces) if surfaces is not None else list(self.m.PROBE_SURFACES)
        with mock.patch.object(self.m, "PROBE_SURFACES", surface_list), \
             mock.patch.object(self.m, "ensure_socks_creds", return_value=("user", "pass")), \
             mock.patch.object(self.m, "sh", side_effect=fake_sh):
            ok = self.m._prevalidate_socks_candidate("se1.nordvpn.com")
        return ok, calls

    def test_default_surface_is_chat(self):
        ok, calls = self._probe()
        self.assertTrue(ok)
        self.assertEqual(len(calls), 1)
        chat = calls[0]
        self.assertTrue(chat[6].endswith("/chat/completions"))
        self.assertIn("user:pass@se1.nordvpn.com:1080", chat[5])
        self.assertIn("Authorization: Bearer public", chat)
        self.assertIn("User-Agent: opencode/1.18.27", chat)
        self.assertIn("x-opencode-client: cli", chat)
        self.assertTrue(any(a.startswith("x-opencode-session: ses_") for a in chat))
        self.assertTrue(any(a.startswith("x-opencode-request: msg_") for a in chat))
        self.assertIn("big-pickle", chat[-1])
        self.assertIn('"content": "hi"', chat[-1])

    def test_chat_failure_rejects_candidate(self):
        ok, _ = self._probe(chat_rc=22)
        self.assertFalse(ok)

    def test_dual_surface_probes_both_when_configured(self):
        ok, calls = self._probe(surfaces=("chat", "responses"))
        self.assertTrue(ok)
        urls = [a[6] for a in calls]
        self.assertTrue(any(u.endswith("/chat/completions") for u in urls))
        self.assertTrue(any(u.endswith("/responses") for u in urls))

if __name__ == "__main__":
    unittest.main(verbosity=2)
