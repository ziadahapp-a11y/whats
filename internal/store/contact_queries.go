package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// Contact-centric queries ported from lharries/whatsapp-mcp
// (get_direct_chat_by_contact, get_contact_chats, get_last_interaction) and
// extended to understand LID identities: a contact may appear as their phone
// JID (447700000001@s.whatsapp.net), a bare phone ("447700000001"), or a LID
// ("99887766@lid") depending on how WhatsApp addressed the message.

// contactIdentity is every key under which one contact may appear in the
// cache.
type contactIdentity struct {
	phone      string   // bare phone digits, "" when unresolvable
	chatJIDs   []string // direct-chat JIDs for this contact
	senderKeys []string // values messages.sender may hold for this contact
}

// normalisePhoneInput strips the characters people commonly type around a
// phone number ("+966 50-123 4567") so lookups match the digits-only form
// WhatsApp stores.
func normalisePhoneInput(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// resolveContactIdentity expands a phone number or JID into every chat JID
// and sender value the contact may be stored under.
func (s *Store) resolveContactIdentity(ctx context.Context, phoneOrJID string) (contactIdentity, error) {
	in := strings.TrimSpace(phoneOrJID)
	if in == "" {
		return contactIdentity{}, fmt.Errorf("contact must not be empty")
	}
	if strings.HasSuffix(in, "@g.us") {
		return contactIdentity{}, fmt.Errorf("%q is a group JID; pass a contact phone number or @s.whatsapp.net JID", in)
	}

	var id contactIdentity
	var lids []string

	switch {
	case strings.HasSuffix(in, "@lid"):
		lid, _, _ := strings.Cut(jidUser(in), ":")
		lids = append(lids, lid)
		if pn := s.ResolveJIDToPhone(lid + "@lid"); pn != "" {
			id.phone = pn
		}
	case strings.Contains(in, "@"):
		u, _, _ := strings.Cut(jidUser(in), ":")
		id.phone = normalisePhoneInput(u)
	default:
		id.phone = normalisePhoneInput(in)
	}

	if id.phone != "" {
		lids = append(lids, s.lidsForPhone(ctx, id.phone)...)
		id.chatJIDs = append(id.chatJIDs, id.phone+"@s.whatsapp.net")
		id.senderKeys = append(id.senderKeys, id.phone, id.phone+"@s.whatsapp.net")
	}
	seen := map[string]bool{}
	for _, lid := range lids {
		if lid == "" || seen[lid] {
			continue
		}
		seen[lid] = true
		id.chatJIDs = append(id.chatJIDs, lid+"@lid")
		id.senderKeys = append(id.senderKeys, lid, lid+"@lid")
	}
	if len(id.chatJIDs) == 0 {
		return contactIdentity{}, fmt.Errorf("could not read a phone number or JID from %q", phoneOrJID)
	}
	return id, nil
}

// lidsForPhone returns every LID whatsmeow has mapped to phone. Best-effort:
// a missing whatsmeow DB or table yields nil.
func (s *Store) lidsForPhone(ctx context.Context, phone string) []string {
	if s.whatsmeowDB == nil {
		return nil
	}
	rows, err := s.whatsmeowDB.QueryContext(ctx, "SELECT lid FROM whatsmeow_lid_map WHERE pn = ?", phone)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var lid string
		if rows.Scan(&lid) == nil && lid != "" {
			out = append(out, lid)
		}
	}
	return out
}

// placeholders returns "?, ?, ?" for n parameters.
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}

func toArgs(ss []string) []any {
	out := make([]any, len(ss))
	for i, v := range ss {
		out[i] = v
	}
	return out
}

// GetDirectChatByContact returns the 1:1 chat with a contact, identified by
// phone number or JID. Returns (nil, nil) when no direct chat is cached.
func (s *Store) GetDirectChatByContact(ctx context.Context, phoneOrJID string) (*Chat, error) {
	id, err := s.resolveContactIdentity(ctx, phoneOrJID)
	if err != nil {
		return nil, err
	}
	// Exact matches first; the phone JID is listed before any LID JIDs, so a
	// resolved chat wins over a stale LID one.
	for _, jid := range id.chatJIDs {
		c, err := s.GetChat(ctx, jid, true)
		if err != nil {
			return nil, err
		}
		if c != nil {
			return c, nil
		}
	}
	// Fallback (matches the original project's behaviour): a partial phone
	// number such as the last 9 digits without the country code. Require
	// enough digits that the LIKE cannot sweep up unrelated chats.
	if len(id.phone) < 7 {
		return nil, nil
	}
	var jid string
	err = s.db.QueryRowContext(ctx, `
		SELECT jid FROM chats
		WHERE jid LIKE ? AND jid NOT LIKE '%@g.us'
		ORDER BY last_message_time DESC
		LIMIT 1`, "%"+id.phone+"%@s.whatsapp.net").Scan(&jid)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get direct chat by contact: %w", err)
	}
	return s.GetChat(ctx, jid, true)
}

// GetContactChats returns every cached chat involving the contact: their
// direct chat plus any group in which they have sent a message, most recently
// active first.
func (s *Store) GetContactChats(ctx context.Context, phoneOrJID string, limit, page int) ([]Chat, error) {
	id, err := s.resolveContactIdentity(ctx, phoneOrJID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if page < 0 {
		page = 0
	}

	q := chatSelectSQL("chats", true) + fmt.Sprintf(`
	WHERE chats.jid IN (%s)
	   OR chats.jid IN (SELECT DISTINCT chat_jid FROM messages WHERE sender IN (%s))
	ORDER BY chats.last_message_time DESC
	LIMIT ? OFFSET ?`, placeholders(len(id.chatJIDs)), placeholders(len(id.senderKeys)))

	args := append(toArgs(id.chatJIDs), toArgs(id.senderKeys)...)
	args = append(args, limit, page*limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("get contact chats: %w", err)
	}
	defer rows.Close()

	var result []Chat
	for rows.Next() {
		c, err := scanChatRow(rows)
		if err != nil {
			return nil, err
		}
		c.PhoneNumber = s.ResolveJIDToPhone(c.JID)
		result = append(result, c)
	}
	return result, rows.Err()
}

// GetLastInteraction returns the most recent cached message exchanged with a
// contact: anything in their direct chat (sent or received) or anything they
// sent in a group. Returns (nil, nil) when there is none.
func (s *Store) GetLastInteraction(ctx context.Context, phoneOrJID string) (*Message, error) {
	id, err := s.resolveContactIdentity(ctx, phoneOrJID)
	if err != nil {
		return nil, err
	}
	q := fmt.Sprintf(`
		SELECT `+listMessageColumns+`
		FROM messages
		JOIN chats ON messages.chat_jid = chats.jid
		WHERE messages.chat_jid IN (%s) OR messages.sender IN (%s)
		ORDER BY messages.timestamp DESC
		LIMIT 1`, placeholders(len(id.chatJIDs)), placeholders(len(id.senderKeys)))
	args := append(toArgs(id.chatJIDs), toArgs(id.senderKeys)...)

	row := s.db.QueryRowContext(ctx, q, args...)
	m, err := s.scanListMessageRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get last interaction: %w", err)
	}
	return &m, nil
}
