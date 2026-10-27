package store

import (
	"context"
	"testing"
)

func TestGetDirectChatByContact(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	cases := map[string]string{
		"447700000001":                "447700000001@s.whatsapp.net",
		"+44 7700-000001":             "447700000001@s.whatsapp.net",
		"447700000001@s.whatsapp.net": "447700000001@s.whatsapp.net",
		"99887766@lid":                "447700000002@s.whatsapp.net", // LID resolves to Bob's phone chat
		"7700000002":                  "447700000002@s.whatsapp.net", // partial number fallback
	}
	for in, want := range cases {
		c, err := s.GetDirectChatByContact(ctx, in)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if c == nil || c.JID != want {
			t.Errorf("%q: got %+v, want jid %s", in, c, want)
		}
	}

	c, err := s.GetDirectChatByContact(ctx, "919900000000")
	if err != nil {
		t.Fatal(err)
	}
	if c != nil {
		t.Errorf("contact without a chat: got %+v, want nil", c)
	}

	if _, err := s.GetDirectChatByContact(ctx, "123456789@g.us"); err == nil {
		t.Error("group JID: want error")
	}
	if _, err := s.GetDirectChatByContact(ctx, "  "); err == nil {
		t.Error("empty input: want error")
	}
}

func TestGetContactChats(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	chats, err := s.GetContactChats(ctx, "447700000001", 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(chats) != 2 {
		t.Fatalf("got %d chats, want 2 (direct + group): %+v", len(chats), chats)
	}
	// Ordered by last activity: the group (2026-01-10) before Alice's DM (2026-01-09).
	if chats[0].JID != "123456789@g.us" || chats[1].JID != "447700000001@s.whatsapp.net" {
		t.Errorf("unexpected order: %s, %s", chats[0].JID, chats[1].JID)
	}

	page1, err := s.GetContactChats(ctx, "447700000001", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(page1) != 1 || page1[0].JID != "447700000001@s.whatsapp.net" {
		t.Errorf("page 1: got %+v", page1)
	}

	none, err := s.GetContactChats(ctx, "919900000000", 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(none) != 0 {
		t.Errorf("contact with no messages: got %d chats", len(none))
	}
}

func TestGetLastInteraction(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	// Bob's latest message is in the group (g4, 2026-01-10), newer than his DM.
	m, err := s.GetLastInteraction(ctx, "447700000002")
	if err != nil {
		t.Fatal(err)
	}
	if m == nil || m.ID != "g4" {
		t.Fatalf("got %+v, want g4", m)
	}

	// Alice: her DM a5 (2026-01-09) beats her group message g1.
	m, err = s.GetLastInteraction(ctx, "447700000001@s.whatsapp.net")
	if err != nil {
		t.Fatal(err)
	}
	if m == nil || m.ID != "a5" {
		t.Fatalf("got %+v, want a5", m)
	}

	m, err = s.GetLastInteraction(ctx, "919900000000")
	if err != nil {
		t.Fatal(err)
	}
	if m != nil {
		t.Errorf("no interaction: got %+v, want nil", m)
	}
}
