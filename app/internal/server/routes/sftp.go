package routes

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	pathpkg "path"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/pkg/sftp"

	"github.com/FloSch62/muxus/app/internal/api"
	"github.com/FloSch62/muxus/app/internal/server"
	"github.com/FloSch62/muxus/app/internal/sshx"
)

const (
	maxRecursiveDelete = 10_000
	maxEditorBytes     = 8 * 1024 * 1024
	downloadTicketTTL  = 2 * time.Minute
)

type sftpProblem struct {
	status, code int
	message      string
	errorCode    string
}

func (p *sftpProblem) Error() string { return p.message }

func writeSFTPError(w http.ResponseWriter, err error) {
	if problem, ok := err.(*sftpProblem); ok {
		server.WriteJSON(w, problem.status, api.ErrorBody{
			Message: problem.message, Code: problem.errorCode,
		})
		return
	}
	writeInternalError(w, err)
}

type downloadTicket struct {
	connID, path string
	expires      time.Time
}

type downloadTicketStore struct {
	mu      sync.Mutex
	tickets map[string]downloadTicket
}

func (s *downloadTicketStore) issue(connID, remotePath string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for key, ticket := range s.tickets {
		if !ticket.expires.After(now) {
			delete(s.tickets, key)
		}
	}
	bytes := make([]byte, 18)
	_, _ = rand.Read(bytes)
	key := base64.RawURLEncoding.EncodeToString(bytes)
	s.tickets[key] = downloadTicket{
		connID: connID, path: remotePath, expires: now.Add(downloadTicketTTL),
	}
	return key
}

func (s *downloadTicketStore) get(key, connID string) (downloadTicket, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ticket, ok := s.tickets[key]
	if !ok || ticket.connID != connID || !ticket.expires.After(time.Now()) {
		if key != "" {
			delete(s.tickets, key)
		}
		return downloadTicket{}, false
	}
	return ticket, true
}

type acquiredSFTP struct {
	client  *sftp.Client
	release func()
}

func acquireSFTP(ctx *server.Context, connID string) (*acquiredSFTP, error) {
	lease := ctx.Connections.Acquire(connID, sshx.OwnerSftp)
	if lease == nil {
		return nil, &sftpProblem{status: http.StatusNotFound, message: "connection not found"}
	}
	client, err := lease.Connection.SFTP()
	if err != nil {
		lease.Release()
		return nil, err
	}
	return &acquiredSFTP{client: client, release: lease.Release}, nil
}

func requireSFTPPath(req *http.Request, bodyPath string) (string, error) {
	path := req.URL.Query().Get("path")
	if path == "" {
		path = bodyPath
	}
	if path == "" {
		return "", &sftpProblem{status: http.StatusBadRequest, message: "path is required"}
	}
	return path, nil
}

func sftpFileFields(info os.FileInfo) (*int64, *int64, *uint32) {
	size := info.Size()
	mtime := info.ModTime().UnixMilli()
	mode := uint32(info.Mode().Perm()) & 0o7777
	if stat, ok := info.Sys().(*sftp.FileStat); ok {
		size = int64(stat.Size)
		mtime = int64(stat.Mtime) * 1000
		mode = stat.Mode & 0o7777
	}
	return &size, &mtime, &mode
}

func sftpEntryType(info os.FileInfo) string {
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		return "link"
	case info.IsDir():
		return "dir"
	case info.Mode().IsRegular():
		return "file"
	default:
		return "other"
	}
}

func streamSFTPDownload(
	w http.ResponseWriter,
	ctx *server.Context,
	connID, remotePath string,
	cacheControl bool,
) error {
	acquired, err := acquireSFTP(ctx, connID)
	if err != nil {
		return err
	}
	defer acquired.release()
	info, err := acquired.client.Stat(remotePath)
	if err != nil {
		return err
	}
	file, err := acquired.client.Open(remotePath)
	if err != nil {
		return err
	}
	defer file.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set(
		"Content-Disposition",
		`attachment; filename="`+url.PathEscape(pathpkg.Base(remotePath))+`"`,
	)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	if cacheControl {
		w.Header().Set("Cache-Control", "no-store")
	}
	_, err = io.Copy(w, file)
	return err
}

func RegisterSFTPRoutes(r chi.Router, ctx *server.Context) {
	tickets := &downloadTicketStore{tickets: map[string]downloadTicket{}}
	withClient := func(w http.ResponseWriter, req *http.Request, fn func(*sftp.Client) error) {
		acquired, err := acquireSFTP(ctx, chi.URLParam(req, "connId"))
		if err != nil {
			writeSFTPError(w, err)
			return
		}
		defer acquired.release()
		if err := fn(acquired.client); err != nil {
			writeSFTPError(w, err)
		}
	}

	r.Get("/api/sftp/{connId}/home", func(w http.ResponseWriter, req *http.Request) {
		withClient(w, req, func(client *sftp.Client) error {
			home, err := client.RealPath(".")
			if err != nil {
				return err
			}
			server.WriteJSON(w, http.StatusOK, map[string]string{"path": home})
			return nil
		})
	})

	r.Get("/api/sftp/{connId}/list", func(w http.ResponseWriter, req *http.Request) {
		withClient(w, req, func(client *sftp.Client) error {
			directory, err := requireSFTPPath(req, "")
			if err != nil {
				return err
			}
			resolved, err := client.RealPath(directory)
			if err != nil {
				return err
			}
			listing, err := client.ReadDir(resolved)
			if err != nil {
				return err
			}
			connID := chi.URLParam(req, "connId")
			entries := make([]api.SftpEntry, 0, len(listing))
			for _, item := range listing {
				if item.Name() == "." || item.Name() == ".." {
					continue
				}
				size, mtime, mode := sftpFileFields(item)
				entry := api.SftpEntry{
					Name: item.Name(), Type: sftpEntryType(item),
					Size: size, MtimeMs: mtime, Mode: mode,
				}
				if entry.Type == "file" {
					entry.DownloadTicket = tickets.issue(
						connID, pathpkg.Join(resolved, item.Name()),
					)
				}
				entries = append(entries, entry)
			}
			server.WriteJSON(w, http.StatusOK, api.SftpListResponse{
				Path: resolved, Entries: entries,
			})
			return nil
		})
	})

	r.Get("/api/sftp/{connId}/download", func(w http.ResponseWriter, req *http.Request) {
		remotePath, err := requireSFTPPath(req, "")
		if err != nil {
			writeSFTPError(w, err)
			return
		}
		if err := streamSFTPDownload(
			w, ctx, chi.URLParam(req, "connId"), remotePath, false,
		); err != nil {
			writeSFTPError(w, err)
		}
	})

	r.Get("/api/sftp/{connId}/drag-download", func(w http.ResponseWriter, req *http.Request) {
		connID := chi.URLParam(req, "connId")
		ticket, ok := tickets.get(req.URL.Query().Get("ticket"), connID)
		if !ok {
			writeSFTPError(w, &sftpProblem{
				status: http.StatusUnauthorized, message: "download ticket is missing or expired",
			})
			return
		}
		if err := streamSFTPDownload(w, ctx, connID, ticket.path, true); err != nil {
			writeSFTPError(w, err)
		}
	})

	r.Get("/api/sftp/{connId}/file", func(w http.ResponseWriter, req *http.Request) {
		withClient(w, req, func(client *sftp.Client) error {
			remotePath, err := requireSFTPPath(req, "")
			if err != nil {
				return err
			}
			info, err := client.Lstat(remotePath)
			if err != nil {
				return err
			}
			if info.IsDir() {
				return &sftpProblem{status: http.StatusBadRequest, message: "cannot edit a directory"}
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return &sftpProblem{
					status: http.StatusConflict, message: "open the symbolic link target explicitly",
					errorCode: "SFTP_EDITOR_SYMLINK",
				}
			}
			if info.Size() > maxEditorBytes {
				return &sftpProblem{
					status:  http.StatusRequestEntityTooLarge,
					message: "files larger than 8 MiB cannot be opened in the editor",
				}
			}
			file, err := client.Open(remotePath)
			if err != nil {
				return err
			}
			defer file.Close()
			content, err := io.ReadAll(io.LimitReader(file, maxEditorBytes+1))
			if err != nil {
				return err
			}
			if len(content) > maxEditorBytes {
				return &sftpProblem{
					status:  http.StatusRequestEntityTooLarge,
					message: "files larger than 8 MiB cannot be opened in the editor",
				}
			}
			if strings.IndexByte(string(content), 0) >= 0 {
				return &sftpProblem{
					status:  http.StatusUnsupportedMediaType,
					message: "this appears to be a binary file and cannot be opened as text",
				}
			}
			if !utf8.Valid(content) {
				return &sftpProblem{
					status:  http.StatusUnsupportedMediaType,
					message: "the remote editor currently supports UTF-8 text files",
				}
			}
			size, mtime, mode := sftpFileFields(info)
			server.WriteJSON(w, http.StatusOK, api.SftpFileResponse{
				Path: remotePath, Content: string(content), Size: *size,
				MtimeMs: mtime, Mode: mode,
			})
			return nil
		})
	})

	r.Put("/api/sftp/{connId}/file", func(w http.ResponseWriter, req *http.Request) {
		withClient(w, req, func(client *sftp.Client) error {
			remotePath, err := requireSFTPPath(req, "")
			if err != nil {
				return err
			}
			body, ok := readJSONBody(w, req, maxEditorBytes+64*1024)
			if !ok {
				return nil
			}
			var input api.SftpFileSaveRequest
			if err := json.Unmarshal(body, &input); err != nil {
				return &sftpProblem{status: http.StatusBadRequest, message: "content must be a string"}
			}
			if len([]byte(input.Content)) > maxEditorBytes {
				return &sftpProblem{
					status:  http.StatusRequestEntityTooLarge,
					message: "files larger than 8 MiB cannot be saved from the editor",
				}
			}
			info, err := client.Lstat(remotePath)
			if err != nil {
				return err
			}
			if info.IsDir() {
				return &sftpProblem{status: http.StatusBadRequest, message: "cannot overwrite a directory"}
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return &sftpProblem{
					status: http.StatusConflict, message: "refusing to overwrite a symbolic link",
					errorCode: "SFTP_DESTINATION_IS_SYMLINK",
				}
			}
			_, mtime, _ := sftpFileFields(info)
			if !input.Force && input.ExpectedMtimeMs != nil && *input.ExpectedMtimeMs != *mtime {
				return &sftpProblem{
					status:    http.StatusConflict,
					message:   "the remote file changed since it was opened",
					errorCode: "SFTP_FILE_CHANGED",
				}
			}
			if err := atomicSFTPBytes(
				client, remotePath, []byte(input.Content), true, info.Mode().Perm(),
			); err != nil {
				return err
			}
			saved, err := client.Stat(remotePath)
			if err != nil {
				return err
			}
			size, savedMtime, _ := sftpFileFields(saved)
			server.WriteJSON(w, http.StatusOK, api.SftpFileSaveResponse{
				OK: true, Size: *size, MtimeMs: savedMtime,
			})
			return nil
		})
	})

	r.Post("/api/sftp/{connId}/upload", func(w http.ResponseWriter, req *http.Request) {
		withClient(w, req, func(client *sftp.Client) error {
			remotePath, err := requireSFTPPath(req, "")
			if err != nil {
				return err
			}
			overwriteRaw := req.URL.Query().Get("overwrite")
			if overwriteRaw != "" && overwriteRaw != "true" && overwriteRaw != "false" {
				return &sftpProblem{status: http.StatusBadRequest, message: "overwrite must be true or false"}
			}
			overwrite := overwriteRaw == "true"
			existing, err := sftpLstatIfPresent(client, remotePath)
			if err != nil {
				return err
			}
			if existing != nil && existing.IsDir() {
				return &sftpProblem{
					status:    http.StatusConflict,
					message:   "a directory already exists at the upload destination",
					errorCode: "SFTP_DESTINATION_IS_DIRECTORY",
				}
			}
			if existing != nil && existing.Mode()&os.ModeSymlink != 0 {
				return &sftpProblem{
					status: http.StatusConflict, message: "refusing to overwrite a symbolic link",
					errorCode: "SFTP_DESTINATION_IS_SYMLINK",
				}
			}
			if existing != nil && !overwrite {
				return &sftpProblem{
					status:    http.StatusConflict,
					message:   "a file already exists at the upload destination",
					errorCode: "SFTP_DESTINATION_EXISTS",
				}
			}
			mode := os.FileMode(0o666)
			if existing != nil {
				mode = existing.Mode().Perm()
			}
			if err := atomicSFTPStream(client, remotePath, req.Body, overwrite, mode); err != nil {
				if !overwrite {
					if current, _ := sftpLstatIfPresent(client, remotePath); current != nil {
						return &sftpProblem{
							status:    http.StatusConflict,
							message:   "a file already exists at the upload destination",
							errorCode: "SFTP_DESTINATION_EXISTS",
						}
					}
				}
				return err
			}
			server.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	})

	r.Post("/api/sftp/{connId}/mkdir", func(w http.ResponseWriter, req *http.Request) {
		withClient(w, req, func(client *sftp.Client) error {
			body, ok := readJSONBody(w, req, defaultBodyLimit)
			if !ok {
				return nil
			}
			var input struct {
				Path      string `json:"path"`
				Recursive bool   `json:"recursive"`
			}
			if json.Unmarshal(body, &input) != nil {
				return &sftpProblem{status: http.StatusBadRequest, message: "path is required"}
			}
			target, err := requireSFTPPath(req, input.Path)
			if err != nil {
				return err
			}
			if input.Recursive {
				err = sftpMkdirRecursive(client, target)
			} else {
				err = client.Mkdir(target)
			}
			if err != nil {
				return err
			}
			server.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	})

	r.Post("/api/sftp/{connId}/rename", func(w http.ResponseWriter, req *http.Request) {
		withClient(w, req, func(client *sftp.Client) error {
			body, ok := readJSONBody(w, req, defaultBodyLimit)
			if !ok {
				return nil
			}
			var input struct {
				From string `json:"from"`
				To   string `json:"to"`
			}
			if json.Unmarshal(body, &input) != nil || input.From == "" || input.To == "" {
				return &sftpProblem{status: http.StatusBadRequest, message: "from and to are required"}
			}
			if err := client.Rename(input.From, input.To); err != nil {
				return err
			}
			server.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	})

	r.Post("/api/sftp/{connId}/delete", func(w http.ResponseWriter, req *http.Request) {
		withClient(w, req, func(client *sftp.Client) error {
			body, ok := readJSONBody(w, req, defaultBodyLimit)
			if !ok {
				return nil
			}
			var input struct {
				Path string `json:"path"`
			}
			_ = json.Unmarshal(body, &input)
			target, err := requireSFTPPath(req, input.Path)
			if err != nil {
				return err
			}
			info, err := client.Lstat(target)
			if err != nil {
				return err
			}
			if info.IsDir() {
				budget := maxRecursiveDelete
				err = sftpDeleteTree(client, target, &budget)
			} else {
				err = client.Remove(target)
			}
			if err != nil {
				return err
			}
			server.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	})
}

func randomSFTPSuffix() string {
	value := make([]byte, 6)
	_, _ = rand.Read(value)
	return hex.EncodeToString(value)
}

func atomicSFTPBytes(
	client *sftp.Client, destination string, content []byte,
	overwrite bool, mode os.FileMode,
) error {
	return atomicSFTPStream(client, destination, strings.NewReader(string(content)), overwrite, mode)
}

func atomicSFTPStream(
	client *sftp.Client, destination string, source io.Reader,
	overwrite bool, mode os.FileMode,
) error {
	temp := destination + ".muxus-" + randomSFTPSuffix() + ".tmp"
	file, err := client.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return err
	}
	if mode != 0 {
		_ = file.Chmod(mode)
	}
	_, copyErr := io.Copy(file, source)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		_ = client.Remove(temp)
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
	if !overwrite {
		if exists, statErr := sftpLstatIfPresent(client, destination); statErr != nil {
			_ = client.Remove(temp)
			return statErr
		} else if exists != nil {
			_ = client.Remove(temp)
			return &sftpProblem{
				status:    http.StatusConflict,
				message:   "a file already exists at the upload destination",
				errorCode: "SFTP_DESTINATION_EXISTS",
			}
		}
		err = client.Rename(temp, destination)
	} else {
		err = client.PosixRename(temp, destination)
		if err != nil {
			if renameErr := client.Rename(temp, destination); renameErr != nil {
				_ = client.Remove(destination)
				err = client.Rename(temp, destination)
			} else {
				err = nil
			}
		}
	}
	if err != nil {
		_ = client.Remove(temp)
	}
	return err
}

func sftpLstatIfPresent(client *sftp.Client, remotePath string) (os.FileInfo, error) {
	info, err := client.Lstat(remotePath)
	if errors.Is(err, sftp.ErrSSHFxNoSuchFile) || errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return info, err
}

func sftpMkdirRecursive(client *sftp.Client, target string) error {
	normalized := pathpkg.Clean(target)
	absolute := strings.HasPrefix(normalized, "/")
	current := "."
	if absolute {
		current = "/"
	}
	for _, part := range strings.Split(normalized, "/") {
		if part == "" || part == "." {
			continue
		}
		current = pathpkg.Join(current, part)
		if err := client.Mkdir(current); err != nil {
			info, statErr := client.Lstat(current)
			if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return err
			}
		}
	}
	return nil
}

func sftpDeleteTree(client *sftp.Client, directory string, budget *int) error {
	listing, err := client.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, item := range listing {
		if item.Name() == "." || item.Name() == ".." {
			continue
		}
		*budget--
		if *budget < 0 {
			return &sftpProblem{
				status:  http.StatusBadRequest,
				message: fmt.Sprintf("refusing to delete more than %d entries", maxRecursiveDelete),
			}
		}
		child := pathpkg.Join(directory, item.Name())
		if item.IsDir() {
			if err := sftpDeleteTree(client, child, budget); err != nil {
				return err
			}
		} else if err := client.Remove(child); err != nil {
			return err
		}
	}
	return client.RemoveDirectory(directory)
}
