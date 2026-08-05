<?php
/**
 * Plugin Name: Storefront MCP Proxy
 * Description: Serves an MCP endpoint under your brand's WordPress domain
 *              (https://yourshop.com/api/mcp) by proxying JSON-RPC requests to
 *              an upstream MCP server (e.g. the Next.js template in this repo
 *              deployed on Vercel). Lets agents connect to the domain your
 *              customers already know, while the server runs wherever you want.
 * Author:      storefront-mcp contributors
 * Version:     1.0.0
 * License:     MIT
 *
 * INSTALL: drop this file into wp-content/mu-plugins/ (create the directory
 * if it does not exist). Must-use plugins need no activation.
 *
 * CONFIGURE the upstream (in order of precedence):
 *   1. define('STOREFRONT_MCP_UPSTREAM', 'https://your-app.example.com/api/mcp');
 *      in wp-config.php, or
 *   2. add_option('storefront_mcp_upstream', 'https://your-app.example.com/api/mcp');
 *
 * SECURITY NOTES:
 *   - The proxy forwards the Authorization header untouched, so the
 *     public/sensitive tool split is enforced by the upstream, not here.
 *   - Payloads are capped at 256 KB: an MCP conversation never needs more,
 *     and the cap keeps the endpoint useless as a relay for anything else.
 *   - On upstream failure the proxy answers with a JSON-RPC error object,
 *     never an HTML error page: the client on the other side is a program.
 */

if (!defined('ABSPATH')) {
    exit;
}

/** Max accepted/forwarded payload size in bytes. */
const STOREFRONT_MCP_MAX_BODY = 262144; // 256 KB

/** Upstream request timeout in seconds. */
const STOREFRONT_MCP_TIMEOUT = 20;

/**
 * Hook on init at priority 0: the MCP path is not a WordPress route, so we
 * answer before the router (and any heavy theme/plugin code) gets involved.
 */
add_action('init', 'storefront_mcp_maybe_handle', 0);

function storefront_mcp_maybe_handle() {
    $path = wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    if ($path === null || untrailingslashit($path) !== '/api/mcp') {
        return;
    }

    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

    // CORS: browser-based MCP clients send a preflight first.
    storefront_mcp_send_cors_headers();
    if ($method === 'OPTIONS') {
        status_header(204);
        exit;
    }

    if ($method === 'GET') {
        storefront_mcp_handle_get();
    }

    if ($method === 'POST') {
        storefront_mcp_handle_post();
    }

    // Anything else: JSON-RPC-shaped refusal, not an HTML 405 page.
    storefront_mcp_json_rpc_error(-32600, 'Method not allowed: use POST for JSON-RPC, GET for the descriptor.', 405);
}

function storefront_mcp_upstream_url() {
    if (defined('STOREFRONT_MCP_UPSTREAM') && STOREFRONT_MCP_UPSTREAM) {
        return STOREFRONT_MCP_UPSTREAM;
    }
    $opt = get_option('storefront_mcp_upstream');
    return is_string($opt) && $opt !== '' ? $opt : null;
}

function storefront_mcp_send_cors_headers() {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, Mcp-Session-Id');
    header('Access-Control-Max-Age: 86400');
}

/**
 * GET: human/crawler-readable descriptor. Answered locally so the endpoint
 * introduces itself even when the upstream is down or not yet configured.
 */
function storefront_mcp_handle_get() {
    $configured = storefront_mcp_upstream_url() !== null;
    wp_send_json(array(
        'name'        => 'storefront-mcp-proxy',
        'version'     => '1.0.0',
        'description' => 'MCP endpoint for this store. POST JSON-RPC 2.0 messages to use it.',
        'transport'   => 'streamable-http',
        'status'      => $configured ? 'ready' : 'upstream not configured',
        'docs'        => home_url('/llms.txt'),
    ));
}

function storefront_mcp_handle_post() {
    $upstream = storefront_mcp_upstream_url();
    if ($upstream === null) {
        storefront_mcp_json_rpc_error(-32603, 'MCP proxy has no upstream configured.', 500);
    }

    $body = file_get_contents('php://input', false, null, 0, STOREFRONT_MCP_MAX_BODY + 1);
    if ($body === false || $body === '') {
        storefront_mcp_json_rpc_error(-32700, 'Empty request body.', 400);
    }
    if (strlen($body) > STOREFRONT_MCP_MAX_BODY) {
        storefront_mcp_json_rpc_error(-32600, 'Payload too large (max 256 KB).', 413);
    }

    $headers = array('Content-Type' => 'application/json');
    // Forward auth untouched: the upstream decides which tools it unlocks.
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if ($auth !== '') {
        $headers['Authorization'] = $auth;
    }

    $response = wp_remote_post($upstream, array(
        'headers'     => $headers,
        'body'        => $body,
        'timeout'     => STOREFRONT_MCP_TIMEOUT,
        'redirection' => 0,
    ));

    if (is_wp_error($response)) {
        storefront_mcp_json_rpc_error(-32603, 'Upstream unreachable: ' . $response->get_error_message(), 502);
    }

    $code = (int) wp_remote_retrieve_response_code($response);
    $payload = (string) wp_remote_retrieve_body($response);

    if (strlen($payload) > STOREFRONT_MCP_MAX_BODY) {
        storefront_mcp_json_rpc_error(-32603, 'Upstream response too large.', 502);
    }

    // The upstream must speak JSON. If it answered with HTML (maintenance
    // page, platform error), translate that into a JSON-RPC error instead of
    // confusing the MCP client with markup.
    if (json_decode($payload) === null && trim($payload) !== 'null') {
        storefront_mcp_json_rpc_error(-32603, 'Upstream returned a non-JSON response (HTTP ' . $code . ').', 502);
    }

    status_header($code > 0 ? $code : 502);
    header('Content-Type: application/json; charset=utf-8');
    echo $payload;
    exit;
}

/**
 * Emit a JSON-RPC 2.0 error envelope and stop. The id is null because the
 * proxy fails before/outside a specific request-response pairing.
 */
function storefront_mcp_json_rpc_error($rpc_code, $message, $http_status) {
    status_header($http_status);
    header('Content-Type: application/json; charset=utf-8');
    echo wp_json_encode(array(
        'jsonrpc' => '2.0',
        'id'      => null,
        'error'   => array('code' => $rpc_code, 'message' => $message),
    ));
    exit;
}
