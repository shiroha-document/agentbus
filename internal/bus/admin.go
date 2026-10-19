package bus

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// AdminName is the commit author used by the approval flow.
const AdminName = "agentbus-admin"

// ApproveOpts configures Approve / Revoke. They run wherever the approver is:
// usually the join workflow in GitHub Actions, or a maintainer's laptop.
type ApproveOpts struct {
	Remote   string  // bus git remote (any URL git can push to)
	Branch   string  // bus branch
	Repo     string  // OWNER/REPO, enables deploy-key management
	GH       *GitHub // admin token client; nil = do not touch deploy keys
	WorkDir  string  // scratch dir for the admin clone
	Approver string  // who approved (GitHub login or free text)
	Ref      string  // request reference, e.g. the issue URL
	Now      func() time.Time
}

// Rotating a key = revoke, then approve the new request (same name).

func (o *ApproveOpts) clone() (*Git, error) {
	if o.Branch == "" {
		o.Branch = "agent-bus"
	}
	if o.WorkDir == "" {
		d, err := os.MkdirTemp("", "agentbus-admin-")
		if err != nil {
			return nil, err
		}
		o.WorkDir = d
	}
	dir := filepath.Join(o.WorkDir, "clone")
	g, err := Clone(o.Remote, o.Branch, dir, AdminName, "")
	if err != nil {
		return nil, err
	}
	return g, g.Pull()
}

func (o *ApproveOpts) now() time.Time {
	if o.Now != nil {
		return o.Now().UTC()
	}
	return time.Now().UTC()
}

// ErrNameTaken: another key already holds this agent name.
var ErrNameTaken = errors.New("agent name already taken by a different key")

// Approve grants r write access (deploy key, when Repo+GH are set) and records
// members/<name>.json on the bus branch. It is idempotent.
func Approve(o ApproveOpts, r *JoinRequest) (*Member, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	fp, _ := Fingerprint(r.PublicKey)
	g, err := o.clone()
	if err != nil {
		return nil, err
	}
	ms := LoadMembers(g.Dir)
	if m := ms[r.Name]; m != nil && !m.Revoked && m.KeySHA256 != fp {
		return nil, fmt.Errorf("%w: %s is %s (revoke it first to rotate keys)", ErrNameTaken, r.Name, m.KeySHA256)
	}
	if _, err := os.Stat(filepath.Join(g.Dir, "agents", r.Name, "profile.json")); err == nil && ms[r.Name] == nil {
		return nil, fmt.Errorf("%w: %s already has a profile on the bus but no membership record", ErrNameTaken, r.Name)
	}
	m := &Member{Name: r.Name, KeySHA256: fp, PublicKey: r.PublicKey, ApprovedBy: o.Approver, ApprovedAt: o.now(), Request: o.Ref}
	if old := ms[r.Name]; old != nil && !old.Revoked && old.KeySHA256 == fp {
		m = old // already approved; just make sure the key is present
	} else {
		// Record membership first: the agent treats "I can read the repo AND
		// members/<me>.json has my key" as approved, so it never races ahead.
		rel, err := WriteMember(g.Dir, m)
		if err != nil {
			return nil, err
		}
		if err := g.Commit("agentbus: approve "+r.Name+" by "+o.Approver, rel); err != nil {
			return nil, err
		}
		if err := g.Push(); err != nil {
			return nil, err
		}
	}
	if o.GH != nil && o.Repo != "" {
		if _, err := o.GH.AddDeployKey(o.Repo, "agentbus:"+r.Name, r.PublicKey); err != nil {
			return m, fmt.Errorf("membership recorded but deploy key failed (re-run approve after fixing): %w", err)
		}
	}
	return m, nil
}

// Revoke removes an agent's deploy key and marks it revoked; events it writes
// after RevokedAt are ignored by every reader.
func Revoke(o ApproveOpts, name string) (*Member, error) {
	g, err := o.clone()
	if err != nil {
		return nil, err
	}
	m := LoadMembers(g.Dir)[name]
	if m == nil {
		return nil, fmt.Errorf("%s is not a member", name)
	}
	if o.GH != nil && o.Repo != "" {
		k, err := o.GH.FindDeployKey(o.Repo, m.PublicKey)
		if err != nil {
			return nil, err
		}
		if k != nil {
			if err := o.GH.DeleteDeployKey(o.Repo, k.ID); err != nil {
				return nil, err
			}
		}
	}
	if !m.Revoked {
		t := o.now()
		m.Revoked, m.RevokedBy, m.RevokedAt = true, o.Approver, &t
	}
	rel, err := WriteMember(g.Dir, m)
	if err != nil {
		return nil, err
	}
	if err := g.Commit("agentbus: revoke "+name+" by "+o.Approver, rel); err != nil {
		return nil, err
	}
	return m, g.Push()
}
