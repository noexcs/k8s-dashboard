/*
Copyright 2025 The Kubernetes Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed under the License.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

// AI 执行层（ai-exec）pod exec 端点：POST /exec
//
// 契约（调用方：ai-exec/lib/tools.js exec_pod 工具，经 127.0.0.1:4467 同容器调用）：
//   请求 body: {cluster, namespace, pod, container?, command: []string, timeoutSeconds?}
//   成功: 200 {exitCode, stdout, stderr}（命令非 0 退出也是 200 + exitCode≠0，模型需要真实退出码）
//   失败: 400 参数错 / 404 集群不存在 / 502 连接或执行错误 {error}
//
// 实现：client-go remotecommand SPDY executor（v4 协议错误通道回传 metav1.Status，
// 非 0 退出被解码为 os/exec.CodeExitError）。超时用 context.WithTimeout 控制，
// 默认 30s、上限 120s。鉴权与其他 API 一致（auth.NewBackendTokenMiddleware）。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/kubernetes-sigs/headlamp/backend/pkg/logger"
	k8sexec "k8s.io/client-go/util/exec"
	"k8s.io/client-go/tools/remotecommand"
)

const (
	defaultExecTimeoutSeconds = 30
	maxExecTimeoutSeconds     = 120
	// 请求体上限（command 列表足够用；防超大 body 占用内存）
	maxExecRequestBytes = 1 << 20
	maxExecArgs         = 32
)

// execRequest 是 POST /exec 的请求体。
type execRequest struct {
	Cluster        string   `json:"cluster"`
	Namespace      string   `json:"namespace"`
	Pod            string   `json:"pod"`
	Container      string   `json:"container"`
	Command        []string `json:"command"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
}

// execResponse 是 POST /exec 的成功响应。
type execResponse struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

func writeExecJSON(w http.ResponseWriter, resp execResponse) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		logger.Log(logger.LevelError, nil, err, "exec: encoding response")
	}
}

func writeExecError(w http.ResponseWriter, status int, err error) {
	logger.Log(logger.LevelError, nil, err, "exec: request failed")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

// handleExec 在 pod 容器内执行一次性命令（非交互），捕获 stdout/stderr。
func (c *HeadlampConfig) handleExec(w http.ResponseWriter, r *http.Request) {
	var req execRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxExecRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeExecError(w, http.StatusBadRequest, err)
		return
	}

	if req.Cluster == "" || req.Namespace == "" || req.Pod == "" {
		writeExecError(w, http.StatusBadRequest, errors.New("cluster/namespace/pod are required"))
		return
	}
	if len(req.Command) == 0 || len(req.Command) > maxExecArgs {
		writeExecError(w, http.StatusBadRequest, fmt.Errorf("command must have 1..%d arguments", maxExecArgs))
		return
	}

	timeoutSec := req.TimeoutSeconds
	if timeoutSec <= 0 {
		timeoutSec = defaultExecTimeoutSeconds
	}
	if timeoutSec > maxExecTimeoutSeconds {
		timeoutSec = maxExecTimeoutSeconds
	}

	// 按集群名取 rest.Config：与 helm 路由同一套流程
	// （GetContext → Copy → token 处理 → RESTConfig）。
	kctx, err := c.KubeConfigStore.GetContext(req.Cluster)
	if err != nil {
		writeExecError(w, http.StatusNotFound, fmt.Errorf("cluster %q: %w", req.Cluster, err))
		return
	}
	kctx = kctx.Copy()
	if c.shouldUseUnsafeServiceAccountTokenForContext(kctx) {
		clearRequestAuthorization(r)
	} else {
		applyRequestTokenToContext(r, req.Cluster, kctx)
	}

	restConf, err := kctx.RESTConfig()
	if err != nil {
		writeExecError(w, http.StatusForbidden, err)
		return
	}

	query := url.Values{}
	for _, arg := range req.Command {
		query.Add("command", arg)
	}
	query.Set("stdout", "true")
	query.Set("stderr", "true")
	if req.Container != "" {
		query.Set("container", req.Container)
	}
	execURL := fmt.Sprintf("%s/api/v1/namespaces/%s/pods/%s/exec?%s",
		strings.TrimSuffix(restConf.Host, "/"),
		url.PathEscape(req.Namespace),
		url.PathEscape(req.Pod),
		query.Encode())

	parsedURL, err := url.Parse(execURL)
	if err != nil {
		writeExecError(w, http.StatusInternalServerError, err)
		return
	}

	executor, err := remotecommand.NewSPDYExecutor(restConf, http.MethodPost, parsedURL)
	if err != nil {
		writeExecError(w, http.StatusBadGateway, err)
		return
	}

	execCtx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	var stdout, stderr bytes.Buffer
	streamErr := executor.StreamWithContext(execCtx, remotecommand.StreamOptions{
		Stdout: &stdout,
		Stderr: &stderr,
	})

	// 命令非 0 退出：v4 错误通道回传 Status，client-go 解码为 exec.CodeExitError。
	var exitErr k8sexec.CodeExitError
	if errors.As(streamErr, &exitErr) {
		resp := execResponse{ExitCode: exitErr.Code, Stdout: stdout.String(), Stderr: stderr.String()}
		if resp.Stderr == "" {
			resp.Stderr = exitErr.Error()
		}
		writeExecJSON(w, resp)
		return
	}

	if streamErr != nil {
		if errors.Is(execCtx.Err(), context.DeadlineExceeded) {
			writeExecError(w, http.StatusBadGateway, fmt.Errorf("exec timed out after %ds", timeoutSec))
		} else {
			// 连接/鉴权/NotFound 等：apiserver 的 Status 错误文本对模型足够有信息量
			writeExecError(w, http.StatusBadGateway, streamErr)
		}
		return
	}

	writeExecJSON(w, execResponse{ExitCode: 0, Stdout: stdout.String(), Stderr: stderr.String()})
}
