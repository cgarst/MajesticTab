import AuthenticationServices
import CommonCrypto
import Foundation
import SwiftRs
import Tauri
import UIKit

struct AuthResult: Encodable {
    let accessToken: String
    let expiresIn: Int
    let refreshToken: String?
}

struct TokenResponse: Decodable {
    let access_token: String?
    let expires_in: Int?
    let refresh_token: String?
    let token_type: String?
    let error: String?
    let error_description: String?
}

class GoogleAuthPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
    private var authSession: ASWebAuthenticationSession?
    private let clientId = "1059497343032-251i1sb21bnbos0hc6ms8uij892oka3p.apps.googleusercontent.com"
    private let callbackScheme = "com.googleusercontent.apps.1059497343032-251i1sb21bnbos0hc6ms8uij892oka3p"
    private let scope = "https://www.googleapis.com/auth/drive.file"

    @objc public func authorize(_ invoke: Invoke) {
        guard let codeVerifier = generateCodeVerifier(),
              let codeChallenge = generateCodeChallenge(from: codeVerifier) else {
            invoke.reject("Failed to generate PKCE challenge.")
            return
        }

        let state = UUID().uuidString
        let redirectUri = "\(callbackScheme):/oauth2redirect"

        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectUri),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "select_account consent")
        ]

        guard let authUrl = components.url else {
            invoke.reject("Failed to construct Google OAuth URL.")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let session = ASWebAuthenticationSession(
                url: authUrl,
                callbackURLScheme: self.callbackScheme
            ) { callbackURL, error in
                self.authSession = nil

                if let error = error {
                    if (error as NSError).code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        invoke.reject("Google authorization was cancelled.")
                    } else {
                        invoke.reject(error.localizedDescription)
                    }
                    return
                }

                guard let callbackURL = callbackURL,
                      let urlComponents = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
                    invoke.reject("Invalid OAuth callback URL received.")
                    return
                }

                let receivedState = urlComponents.queryItems?.first(where: { $0.name == "state" })?.value
                if receivedState != state {
                    invoke.reject("OAuth state mismatch.")
                    return
                }

                if let errorParam = urlComponents.queryItems?.first(where: { $0.name == "error" })?.value {
                    invoke.reject("Google OAuth error: \(errorParam)")
                    return
                }

                guard let code = urlComponents.queryItems?.first(where: { $0.name == "code" })?.value else {
                    invoke.reject("Google authorization did not return an authorization code.")
                    return
                }

                self.exchangeCodeForToken(code: code, codeVerifier: codeVerifier, redirectUri: redirectUri, invoke: invoke)
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.authSession = session

            if !session.start() {
                invoke.reject("Failed to start ASWebAuthenticationSession.")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = manager.viewController?.view.window {
            return window
        }
        if let keyWindow = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap({ $0.windows })
            .first(where: { $0.isKeyWindow }) {
            return keyWindow
        }
        return ASPresentationAnchor()
    }

    private func exchangeCodeForToken(code: String, codeVerifier: String, redirectUri: String, invoke: Invoke) {
        guard let tokenUrl = URL(string: "https://oauth2.googleapis.com/token") else {
            invoke.reject("Invalid token endpoint URL.")
            return
        }

        var request = URLRequest(url: tokenUrl)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let params: [String: String] = [
            "client_id": clientId,
            "code": code,
            "code_verifier": codeVerifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirectUri
        ]

        let bodyString = params.map { key, value in
            let escapedKey = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key
            let escapedValue = value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
            return "\(escapedKey)=\(escapedValue)"
        }.joined(separator: "&")

        request.httpBody = bodyString.data(using: .utf8)

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                invoke.reject("Token exchange network error: \(error.localizedDescription)")
                return
            }

            guard let data = data else {
                invoke.reject("No data received from Google token exchange.")
                return
            }

            do {
                let tokenRes = try JSONDecoder().decode(TokenResponse.self, from: data)
                if let errorMsg = tokenRes.error_description ?? tokenRes.error {
                    invoke.reject("Token exchange failed: \(errorMsg)")
                    return
                }

                guard let accessToken = tokenRes.access_token, !accessToken.isEmpty else {
                    invoke.reject("Google authorization did not return an access token.")
                    return
                }

                let expiresIn = tokenRes.expires_in ?? 3600
                invoke.resolve(AuthResult(accessToken: accessToken, expiresIn: expiresIn, refreshToken: tokenRes.refresh_token))
            } catch {
                invoke.reject("Failed to parse Google token exchange response: \(error.localizedDescription)")
            }
        }.resume()
    }

    private func generateCodeVerifier() -> String? {
        var buffer = [UInt8](repeating: 0, count: 32)
        let result = SecRandomCopyBytes(kSecRandomDefault, buffer.count, &buffer)
        guard result == errSecSuccess else { return nil }
        return Data(buffer).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }

    private func generateCodeChallenge(from verifier: String) -> String? {
        guard let data = verifier.data(using: .ascii) else { return nil }
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes {
            _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &digest)
        }
        return Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }
}

@_cdecl("init_plugin_google_auth")
public func initPlugin() -> Plugin {
    return GoogleAuthPlugin()
}
