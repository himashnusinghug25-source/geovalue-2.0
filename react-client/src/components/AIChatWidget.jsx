import { useEffect, useRef, useState } from "react";
import axios from "axios";

const DEFAULT_SUGGESTIONS = [
  "Why is the risk score at this level?",
  "Explain the 10-year Infra vs Adverse Risk forecast",
  "How sensitive is valuation to hazard distance?",
];

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
        "Hello! I'm the GeoValue AI Valuation Assistant. Click any parcel on the map and ask me about its climate risk score, hazard distance, or 10-year ARIMA-X trajectories.",
    },
  ]);

  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  const buildParcelContext = () => {
    if (!selectedParcel) return null;
    return {
      parcel_id: selectedParcel.parcel_id,
      circle_rate: selectedParcel.circle_rate,
      distance_to_hazard: selectedParcel.distance_to_hazard,
      risk_score: prediction?.risk_score ?? null,
      risk_adjusted_valuation: prediction?.risk_adjusted_valuation ?? null,
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
        if (!proxyErr.response || proxyErr.response.status >= 500 || proxyErr.response.status === 404) {
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

      if (Array.isArray(data?.suggested_questions) && data.suggested_questions.length > 0) {
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
          className="ai-chat-launcher"
          onClick={() => setIsOpen(true)}
        >
          <span className={`launcher-dot ${selectedParcel ? "ready" : ""}`} />
          <span>GeoValue AI Assistant</span>
        </button>
      ) : (
        <section className="ai-chat-panel" aria-label="AI Valuation Chat Assistant">
          <header className="ai-chat-header">
            <div className="ai-chat-title-block">
              <strong>AI Valuation Assistant</strong>
              <span className="ai-chat-context-pill">
                {selectedParcel
                  ? `Parcel ${selectedParcel.parcel_id}`
                  : "No parcel selected"}
              </span>
            </div>
            <button
              type="button"
              className="modal-close-btn"
              onClick={() => setIsOpen(false)}
              aria-label="Minimize chat"
            >
              −
            </button>
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
                {msg.content}
              </div>
            ))}
            {sending && (
              <div className="chat-bubble chat-assistant chat-typing">
                Analyzing parcel model &amp; ARIMA-X projections...
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
                  ? `Ask about ${selectedParcel.parcel_id}...`
                  : "Ask about GeoValue risk & forecasts..."
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
