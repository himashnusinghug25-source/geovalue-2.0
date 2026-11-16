import { useEffect, useRef, useState } from "react";
import axios from "axios";

const DEFAULT_SUGGESTIONS = [
  "Explain the AHP weights & ₹/Gaj breakdown",
  "How do nearby registry sales compare?",
  "Show 10-year Policy Catalyst vs Adverse Risk forecast",
];

/**
 * Render simple **bold** inline segments safely without raw HTML injection.
 */
function renderFormattedText(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

export default function AIChatWidget({
  nodeApiUrl,
  riskApiUrl,
  selectedParcel,
  prediction,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState(DEFAULT_SUGGESTIONS);
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content:
        "GeoValue Copilot ready. Select any NCR parcel on the map to ask about its **₹/Gaj** valuation, Saaty **AHP weights**, nearby registry deals, or 10-year policy forecasts.",
    },
  ]);

  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen, sending]);

  const buildParcelContext = () => {
    if (!selectedParcel) return null;
    return {
      parcel_id: selectedParcel.parcel_id,
      circle_rate: selectedParcel.circle_rate,
      distance_to_hazard: selectedParcel.distance_to_hazard,
      plot_area_gaj: prediction?.plot_area_gaj ?? selectedParcel.plot_area_gaj ?? null,
      sub_region: selectedParcel.sub_region ?? null,
      risk_score: prediction?.risk_score ?? null,
      risk_adjusted_valuation: prediction?.risk_adjusted_valuation ?? null,
      total_plot_valuation_inr: prediction?.total_plot_valuation_inr ?? null,
      baseline_trajectory: prediction?.baseline_trajectory ?? null,
      infrastructure_trajectory: prediction?.infrastructure_trajectory ?? null,
      adverse_risk_trajectory: prediction?.adverse_risk_trajectory ?? null,
      horizon_milestones: prediction?.horizon_milestones ?? null,
    };
  };

  const sendMessage = async (textToSend) => {
    const trimmed = textToSend.trim();
    if (!trimmed || sending) return;

    const userMsg = { role: "user", content: trimmed };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput("");
    setSending(true);

    const payload = {
      message: trimmed,
      parcel_context: buildParcelContext(),
      history: nextHistory.slice(-6),
    };

    try {
      let data;
      try {
        const res = await axios.post(`${nodeApiUrl}/api/chat/valuation`, payload);
        data = res.data;
      } catch (proxyErr) {
        if (
          !proxyErr.response ||
          proxyErr.response.status >= 500 ||
          proxyErr.response.status === 404
        ) {
          const directRes = await axios.post(`${riskApiUrl}/chat/valuation`, payload);
          data = directRes.data;
        } else {
          throw proxyErr;
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data?.reply || "No analysis returned from the valuation engine.",
        },
      ]);

      if (
        Array.isArray(data?.suggested_questions) &&
        data.suggested_questions.length > 0
      ) {
        setSuggestions(data.suggested_questions);
      }
    } catch (err) {
      const errMsg =
        err.response?.data?.error ||
        err.response?.data?.detail ||
        err.message ||
        "Unable to reach the AI valuation service.";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${errMsg}`,
          isError: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <div className="ai-chat-anchor">
      {!isOpen ? (
        <button
          type="button"
          className="ai-chat-launcher glass-surface"
          onClick={() => setIsOpen(true)}
        >
          <span className={`launcher-dot ${selectedParcel ? "ready" : ""}`} />
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="copilot-spark-icon"
          >
            <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
          </svg>
          <span>GeoValue Copilot</span>
          {selectedParcel && (
            <span className="launcher-parcel-tag mono">
              {selectedParcel.parcel_id}
            </span>
          )}
        </button>
      ) : (
        <section
          className="ai-chat-panel glass-surface"
          aria-label="AI Valuation Chat Assistant"
        >
          <header className="ai-chat-header">
            <div className="ai-chat-title-block">
              <span className={`launcher-dot ${selectedParcel ? "ready" : ""}`} />
              <div>
                <strong>AI Valuation Copilot</strong>
                <div className="ai-chat-subline">
                  {selectedParcel
                    ? `Grounded on ${selectedParcel.parcel_id} (₹/Gaj & AHP)`
                    : "Awaiting parcel selection"}
                </div>
              </div>
            </div>
            <div className="ai-chat-header-right">
              {prediction && (
                <span className="ai-chat-risk-pill mono">
                  {prediction.risk_score}/100
                </span>
              )}
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setIsOpen(false)}
                aria-label="Minimize chat"
              >
                −
              </button>
            </div>
          </header>

          <div className="ai-chat-messages" ref={scrollRef}>
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`chat-bubble ${
                  msg.role === "user"
                    ? "chat-user"
                    : msg.isError
                    ? "chat-error"
                    : "chat-assistant"
                }`}
              >
                {renderFormattedText(msg.content)}
              </div>
            ))}
            {sending && (
              <div className="chat-bubble chat-assistant chat-typing">
                <span className="typing-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>Analyzing AHP weights, ₹/Gaj &amp; ARIMA-X...</span>
              </div>
            )}
          </div>

          <div className="ai-chat-suggestions">
            {suggestions.slice(0, 3).map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="chat-suggestion-chip"
                onClick={() => sendMessage(prompt)}
                disabled={sending}
              >
                {prompt}
              </button>
            ))}
          </div>

          <form className="ai-chat-input-row" onSubmit={handleSubmit}>
            <input
              type="text"
              placeholder={
                selectedParcel
                  ? `Ask about ${selectedParcel.parcel_id} (₹/Gaj, AHP, comps)...`
                  : "Ask about AHP weights, ₹/Gaj & NCR policies..."
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={sending}
            />
            <button type="submit" disabled={sending || !input.trim()}>
              Send
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
