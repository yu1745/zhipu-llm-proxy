package main

import (
	"context"
	stdtls "crypto/tls"
	"net"
	"net/http"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
)

// node22ClientHello approximates Node.js 22.23.1 with OpenSSL 3.5.x.
// It intentionally advertises HTTP/1.1 only, matching Node's built-in fetch.
func node22ClientHello() *utls.ClientHelloSpec {
	return &utls.ClientHelloSpec{
		TLSVersMin: utls.VersionTLS12,
		TLSVersMax: utls.VersionTLS13,
		CipherSuites: []uint16{
			4866, 4867, 4865,
			49199, 49195, 49200, 49196, 158,
			49191, 103, 49192, 107, 163, 159,
			52393, 52392, 52394,
			49325, 49311,
			49245, 49249, 49239, 49235,
			162,
			49324, 49310,
			49244, 49248, 49238, 49234,
			49188, 106, 49187, 64,
			49162, 49172, 57, 56,
			49161, 49171, 51, 50,
			157, 49309, 49233,
			156, 49308, 49232,
			61, 60, 53, 47,
		},
		CompressionMethods: []uint8{0},
		Extensions: []utls.TLSExtension{
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},
			&utls.SNIExtension{},
			&utls.SupportedPointsExtension{SupportedPoints: []uint8{0, 1, 2}},
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{
				utls.X25519MLKEM768, utls.X25519, utls.CurveP256, utls.CurveID(30),
				utls.CurveP384, utls.CurveP521, utls.CurveID(256), utls.CurveID(257),
			}},
			&utls.SessionTicketExtension{},
			&utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}},
			&utls.GenericExtension{Id: 22},
			&utls.ExtendedMasterSecretExtension{},
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []utls.SignatureScheme{
				0x0905, 0x0906, 0x0904,
				0x0403, 0x0503, 0x0603,
				0x0807, 0x0808,
				0x081a, 0x081b, 0x081c,
				0x0809, 0x080a, 0x080b,
				0x0804, 0x0805, 0x0806,
				0x0401, 0x0501, 0x0601,
				0x0303, 0x0301, 0x0302,
				0x0402, 0x0502, 0x0602,
			}},
			&utls.SupportedVersionsExtension{Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{
				{Group: utls.X25519MLKEM768}, {Group: utls.X25519},
			}},
		},
	}
}

func nodeTLSConn(ctx context.Context, raw net.Conn, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = strings.Trim(addr, "[]")
	}
	conn := utls.UClient(raw, &utls.Config{ServerName: host, MinVersion: utls.VersionTLS12, MaxVersion: utls.VersionTLS13}, utls.HelloCustom)
	if err := conn.ApplyPreset(node22ClientHello()); err != nil {
		_ = raw.Close()
		return nil, err
	}
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}
	return conn, nil
}

func newNodeLikeTransport(rawDial func(context.Context, string, string) (net.Conn, error)) *http.Transport {
	return &http.Transport{
		Proxy: nil,
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			raw, err := rawDial(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return nodeTLSConn(ctx, raw, addr)
		},
		ForceAttemptHTTP2:     false,
		TLSNextProto:          map[string]func(string, *stdtls.Conn) http.RoundTripper{},
		DisableCompression:    true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 10 * time.Minute,
	}
}
