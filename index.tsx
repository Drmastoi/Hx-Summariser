/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import {GoogleGenAI, Part, Type} from '@google/genai';
import React, {useState, useMemo, useEffect, useRef} from 'react';
import ReactDOM from 'react-dom/client';

// Helper function to convert string to kebab-case for CSS classes
const toKebabCase = (str: string) =>
  str.toLowerCase()
     .replace(/[^a-zA-Z0-9 ]/g, "")
     .replace(/\s+/g, '-');

// Define the structure of a single summary
interface StructuredResponse {
  'Acute Issues': string[];
  'Pending Tasks and action Plan': string[];
  'Past medical history': string[];
  'Key Changes'?: string[]; // Optional field for updates
}

// Define the structure for a summary record with a timestamp
interface SummaryRecord {
  summary: StructuredResponse;
  timestamp: string;
}

// Define the structure for a patient
interface Patient {
  id: string;
  name: string;
  summaries: SummaryRecord[];
}

// Define the base schema for the Gemini API call
const baseSchema = {
  'Acute Issues': {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: 'List of acute medical issues.'
  },
  'Pending Tasks and action Plan': {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: 'List of pending tasks and the plan of action, including immediate and long-term plans.'
  },
  'Past medical history': {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: 'List of relevant past medical history.'
  },
};

const newSummaryResponseSchema = {
  type: Type.OBJECT,
  properties: baseSchema,
  required: ['Acute Issues', 'Pending Tasks and action Plan', 'Past medical history'],
};

const updateSummaryResponseSchema = {
    type: Type.OBJECT,
    properties: {
        ...baseSchema,
        'Key Changes': {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'List the key changes from the previous summary based on the new information.'
        }
    },
    required: ['Acute Issues', 'Pending Tasks and action Plan', 'Past medical history', 'Key Changes'],
};


// Helper function to convert a File object to a base64 string
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = (error) => reject(error);
  });
}

function App() {
  // Form and API state
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // AI Insights state
  const [insights, setInsights] = useState<string | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  
  // Referral Letter state
  const [referralLetter, setReferralLetter] = useState<string | null>(null);
  const [referralSpecialty, setReferralSpecialty] = useState<string | null>(null);
  const [referralLetterLoading, setReferralLetterLoading] = useState(false);
  const [referralCopied, setReferralCopied] = useState(false);
  const [showReferralInput, setShowReferralInput] = useState(false);
  const [referralSpecialtyInput, setReferralSpecialtyInput] = useState('');
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const referralContainerRef = useRef<HTMLDivElement>(null);

  // Voice Dictation state
  const [isListening, setIsListening] = useState(false);
  // FIX: Use `any` for SpeechRecognition type as it is not defined in the current TS scope
  // and is shadowed by a constant with the same name.
  const recognitionRef = useRef<any | null>(null);

  // Patient management state with autosave from localStorage
  const [patients, setPatients] = useState<Patient[]>(() => {
    try {
      const savedData = localStorage.getItem('patientData');
      return savedData ? JSON.parse(savedData) : [];
    } catch (e) {
      console.error("Failed to parse patient data from localStorage", e);
      return [];
    }
  });

  const [newPatientName, setNewPatientName] = useState('');
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewingSummaryIndex, setViewingSummaryIndex] = useState(0);

  // Check for SpeechRecognition API
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const isSpeechRecognitionSupported = !!SpeechRecognition;
  
  // Effect to save patients to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('patientData', JSON.stringify(patients));
  }, [patients]);
  
  // Effect to scroll to the referral letter when it's generated
  useEffect(() => {
    if (referralLetter && referralContainerRef.current) {
      referralContainerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [referralLetter]);

  // Effect to set up Speech Recognition
  useEffect(() => {
    if (!isSpeechRecognitionSupported) {
      console.warn("Speech recognition not supported by this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-GB';

    // FIX: Use `any` for SpeechRecognitionEvent type as it is not defined in the current TS scope.
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setPrompt(prevPrompt => (prevPrompt ? prevPrompt + ' ' : '') + transcript);
    };

    // FIX: Use `any` for SpeechRecognitionErrorEvent type as it is not defined in the current TS scope.
    recognition.onerror = (event: any) => {
      console.error('Speech recognition error', event.error);
      if (event.error !== 'no-speech') {
        setError(`Speech recognition error: ${event.error}`);
      }
      setIsListening(false);
    };
    
    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      recognitionRef.current?.abort();
    };
  }, [isSpeechRecognitionSupported]);
  
  const handleToggleListening = () => {
    if (loading || !recognitionRef.current) return;

    if (isListening) {
      recognitionRef.current.stop();
    } else {
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch(e) {
        console.error("Could not start recognition: ", e);
        setError("Microphone not ready. Please try again.");
      }
    }
  };

  const selectedPatient = useMemo(() => {
    return patients.find(p => p.id === selectedPatientId) || null;
  }, [patients, selectedPatientId]);

  const currentSummary = useMemo(() => {
    if (!selectedPatient || !selectedPatient.summaries[viewingSummaryIndex]) {
        return null;
    }
    return selectedPatient.summaries[viewingSummaryIndex];
  }, [selectedPatient, viewingSummaryIndex]);

  // Clear insights and referral letter when the viewed summary changes
  useEffect(() => {
    setInsights(null);
    setReferralLetter(null);
    setReferralSpecialty(null);
  }, [currentSummary]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(prevFiles => [...prevFiles, ...Array.from(e.target.files!)]);
    }
  };

  const handleRemoveFile = (indexToRemove: number) => {
    setFiles(prevFiles => prevFiles.filter((_, index) => index !== indexToRemove));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() && files.length === 0) return;
    if (!selectedPatientId && !newPatientName.trim()) {
        setError("Please enter a patient name.");
        return;
    }

    setLoading(true);
    setError(null);
    setCopied(false);
    setInsights(null);
    setReferralLetter(null);
    setReferralSpecialty(null);

    try {
      const ai = new GoogleGenAI({apiKey: process.env.API_KEY});
      const parts: Part[] = [];

      if (files.length > 0) {
        for (const file of files) {
          const base64Data = await fileToBase64(file);
          parts.push({
            inlineData: { mimeType: file.type, data: base64Data },
          });
        }
      }

      let finalPrompt = '';
      let schemaForRequest = newSummaryResponseSchema;
      const patientToUpdate = selectedPatient;
      const latestExistingSummary = patientToUpdate?.summaries[0];

      if (patientToUpdate && latestExistingSummary) {
        finalPrompt = `Act as a clinical assistant responsible for patient records. A patient has presented with new acute concerns. Based on these and their previous clinical summary, provide an updated summary.

Crucially, within the "Pending Tasks and action Plan" section, you must explicitly document a detailed treatment plan for the new acute concerns, formatted clearly for inclusion in an Electronic Health Record (EHR). This plan must be actionable and follow standard clinical practice. Also, generate a long-term management plan and identify key changes from the previous summary.

PREVIOUS SUMMARY:
${JSON.stringify(latestExistingSummary.summary)}

NEW ACUTE CONCERNS:
${prompt}`;
        schemaForRequest = updateSummaryResponseSchema;
      } else {
        finalPrompt = `Act as a clinical assistant responsible for patient records. Create a concise, structured clinical summary from the information provided. For any acute issues identified, you must explicitly document a detailed treatment plan within the "Pending Tasks and action Plan" section. This plan must be formatted clearly for inclusion in an Electronic Health Record (EHR), be actionable, and follow standard clinical practice. Also, include a suggested long-term management plan.

PATIENT INFORMATION:
${prompt}`;
      }
      
      parts.push({text: finalPrompt});

      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {parts},
        config: {
          responseMimeType: 'application/json',
          responseSchema: schemaForRequest,
        },
      });

      const jsonText = result.text.trim();
      const newSummaryData: StructuredResponse = JSON.parse(jsonText);
      const newSummaryRecord: SummaryRecord = {
        summary: newSummaryData,
        timestamp: new Date().toISOString(),
      };
      
      setViewingSummaryIndex(0); // Always view the newest summary after submission

      if (selectedPatientId) {
        // Update existing patient
        setPatients(prevPatients =>
          prevPatients.map(p =>
            p.id === selectedPatientId
              ? { ...p, summaries: [newSummaryRecord, ...p.summaries] }
              : p
          )
        );
      } else {
        // Create new patient
        const newPatient: Patient = {
          id: Date.now().toString(),
          name: newPatientName.trim(),
          summaries: [newSummaryRecord],
        };
        setPatients(prevPatients => [newPatient, ...prevPatients]);
        setSelectedPatientId(newPatient.id);
        setNewPatientName('');
      }
      setPrompt('');
      clearFiles();

    } catch (err) {
      console.error('Error generating content:', err);
      setError('Sorry, something went wrong. The response might not be in the correct format.');
    } finally {
      setLoading(false);
    }
  };

  const handleGetAiInsights = async () => {
    if (!currentSummary) return;

    setInsightsLoading(true);
    setInsights(null);
    setError(null);

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const insightsPrompt = `You are a clinical decision support assistant for UK clinicians. Based on the provided clinical summary, provide a very brief, rapid-fire action plan.

Your response must be in British English and explicitly aligned with UK NICE (National Institute for Health and Care Excellence) and CKS (Clinical Knowledge Summaries) guidelines.

Please outline 5 critical bullet points for immediate management. Be extremely concise.

---
**PATIENT SUMMARY:**
${JSON.stringify(currentSummary.summary, null, 2)}`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: insightsPrompt,
        });

        setInsights(response.text);

    } catch (err) {
        console.error("Error generating insights:", err);
        setError("Could not generate AI insights at this time.");
    } finally {
        setInsightsLoading(false);
    }
  };

  const handleGenerateReferral = async () => {
    if (!currentSummary || !selectedPatient || !referralSpecialtyInput.trim()) return;

    setReferralLetterLoading(true);
    setReferralLetter(null);
    setReferralSpecialty(referralSpecialtyInput.trim());
    setError(null);

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const referralPrompt = `You are an assistant for a UK clinician. Draft an extremely concise, to-the-point, UK-style referral letter to a ${referralSpecialtyInput.trim()} specialist for ${selectedPatient.name}.

The entire letter must be a maximum of 3-4 lines. It should only contain the most critical information for the specialist. Use placeholders like [NHS Number] where needed.

---
**PATIENT SUMMARY:**
${JSON.stringify(currentSummary.summary, null, 2)}`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro', // Upgraded model for higher quality
            contents: referralPrompt,
        });

        setReferralLetter(response.text);
        setShowReferralInput(false); // Hide form on success
        setReferralSpecialtyInput(''); // Clear input on success

    } catch (err) {
        console.error("Error drafting referral letter:", err);
        setError("Could not draft the referral letter at this time.");
        setReferralSpecialty(null); // Clear specialty on error
    } finally {
        setReferralLetterLoading(false);
    }
  };

  const handleCopyReferral = () => {
    if (!referralLetter) return;
    navigator.clipboard.writeText(referralLetter).then(() => {
        setReferralCopied(true);
        setTimeout(() => setReferralCopied(false), 2000);
    }).catch(err => console.error('Failed to copy referral: ', err));
  };

  const handleExportPdf = () => {
    if (typeof (window as any).html2pdf === 'undefined') {
      setError("PDF export library is not available. Please check your internet connection and try again.");
      return;
    }

    if (!currentSummary || !selectedPatient) {
      alert("No summary to export.");
      return;
    }

    setIsExportingPdf(true);
    setError(null);

    // Create a container for the export content
    const exportContainer = document.createElement('div');

    // Clone all the printable elements
    const header = document.querySelector('.printable-header')?.cloneNode(true);
    const responseArea = document.querySelector('.response-area')?.cloneNode(true);
    const insights = document.querySelector('.ai-insights-container')?.cloneNode(true);
    const referral = document.querySelector('.referral-letter-container')?.cloneNode(true);

    // Append cloned elements to the container
    if (header) exportContainer.appendChild(header);
    if (responseArea) {
      // Remove the placeholder text from the clone if it exists
      const noSummaryText = (responseArea as HTMLElement).querySelector('.no-print');
      if (noSummaryText) {
        noSummaryText.remove();
      }
      exportContainer.appendChild(responseArea);
    }
    if (insights) exportContainer.appendChild(insights);
    if (referral) exportContainer.appendChild(referral);

    // Add print-specific styles to the container
    const style = document.createElement('style');
    style.innerHTML = `
      body { font-family: 'Times New Roman', Times, serif; color: #000; }
      div { background-color: #fff !important; border: none !important; box-shadow: none !important; }
      h1, h2, h3, h4 { color: #000 !important; border-color: #ccc !important; }
      h1 { font-size: 24pt; }
      h2 { font-size: 18pt; }
      h3, h4 { font-size: 14pt; }
      li { line-height: 1.5; }
      ul { padding-left: 20px; }
      .summary-timestamp { text-align: left !important; margin-bottom: 2rem; }
      .key-changes-section { page-break-after: auto; }
      .ai-insights-container, .referral-letter-container { page-break-before: always; }
      .referral-text { font-family: 'Courier New', Courier, monospace; white-space: pre-wrap; word-wrap: break-word; }
    `;
    exportContainer.prepend(style);

    const patientName = selectedPatient.name.replace(/\s+/g, '_');
    const filename = `${patientName}_Clinical_Summary.pdf`;

    const options = {
      margin: 0.75,
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, letterRendering: true },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    // Type assertion for html2pdf on window
    (window as any).html2pdf().from(exportContainer).set(options).save().then(() => {
      setIsExportingPdf(false);
    }).catch((err: Error) => {
      console.error("PDF generation failed:", err);
      setError("Sorry, there was an error exporting the PDF.");
      setIsExportingPdf(false);
    });
  };

  const clearFiles = () => {
    setFiles([]);
    const fileInput = document.getElementById('file-upload') as HTMLInputElement;
    if (fileInput) fileInput.value = '';
  };
  
  const handleSelectPatient = (patientId: string) => {
    setSelectedPatientId(patientId);
    setViewingSummaryIndex(0);
    setError(null);
    setPrompt('');
    clearFiles();
    setInsights(null);
  }

  const handleDeletePatient = (patientIdToDelete: string, patientName: string) => {
    if (window.confirm(`Are you sure you want to delete all records for ${patientName}?`)) {
        setPatients(prev => prev.filter(p => p.id !== patientIdToDelete));
        if (selectedPatientId === patientIdToDelete) {
            setSelectedPatientId(null);
        }
    }
  }

  const handleCreateNew = () => {
    setSelectedPatientId(null);
    setViewingSummaryIndex(0);
    setNewPatientName('');
    setError(null);
    setPrompt('');
    clearFiles();
    setInsights(null);
  }

  const handleCopy = () => {
    if (!currentSummary) return;
    
    const { summary } = currentSummary;
    const keyChanges = summary['Key Changes'] ? `Key Changes:\n${summary['Key Changes'].map(item => `- ${item}`).join('\n')}\n\n` : '';
    
    const formattedResponse = `${keyChanges}${Object.entries(summary)
      .filter(([key]) => key !== 'Key Changes')
      .map(([key, value]) => {
        const listItems = Array.isArray(value) ? value.map(item => `- ${item}`).join('\n') : value;
        return `${key}:\n${listItems}`;
      })
      .join('\n\n')}`;

    navigator.clipboard.writeText(formattedResponse).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(err => console.error('Failed to copy: ', err));
  };
  
  const filteredPatients = patients.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="app-layout">
      <div className="sidebar">
        <h2>Patient Records</h2>
        <input 
            type="search"
            placeholder="Search patients..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
        />
        <ul className="patient-list">
          {filteredPatients.map((patient) => (
            <li 
                key={patient.id} 
                className={patient.id === selectedPatientId ? 'active' : ''}
            >
              <span onClick={() => handleSelectPatient(patient.id)} className="patient-name">
                {patient.name}
              </span>
              <button 
                onClick={(e) => {
                    e.stopPropagation();
                    handleDeletePatient(patient.id, patient.name)
                }} 
                className="delete-patient-btn"
                aria-label={`Delete patient ${patient.name}`}
              >&times;</button>
            </li>
          ))}
        </ul>
      </div>
      <div className="main-content">
        <div className="printable-header">
            <h1>{selectedPatient ? selectedPatient.name : 'New Patient Summary'}</h1>
        </div>
        
        {selectedPatient && (
            <button onClick={handleCreateNew} className="new-patient-btn no-print">
                + Summarize for New Patient
            </button>
        )}
        <form onSubmit={handleSubmit} className="no-print">
          {!selectedPatient && (
              <div className="form-row">
                  <input
                      type="text"
                      value={newPatientName}
                      onChange={(e) => setNewPatientName(e.target.value)}
                      placeholder="Enter new patient name..."
                      disabled={loading}
                      aria-label="New patient name"
                  />
              </div>
          )}
          <div className="form-row">
            <div className="input-with-mic">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Enter acute concerns (e.g., new confusion, new cough)..."
                disabled={loading}
                aria-label="Acute concerns input"
              />
              {isSpeechRecognitionSupported && (
                <button
                  type="button"
                  onClick={handleToggleListening}
                  className={`mic-button ${isListening ? 'listening' : ''}`}
                  disabled={loading}
                  aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
                </button>
              )}
            </div>
            <button type="submit" disabled={loading || (!prompt.trim() && files.length === 0)}>
              {loading ? (selectedPatient ? 'Updating Summary...' : 'Generating Summary...') : (selectedPatient ? 'Update Summary' : 'Submit')}
            </button>
          </div>
          <div className="form-row">
            <label htmlFor="file-upload" className="file-upload-button" aria-disabled={loading}>
              Upload Document(s)
            </label>
            <input
              id="file-upload"
              type="file"
              onChange={handleFileChange}
              disabled={loading}
              multiple
            />
          </div>
        </form>
        {files.length > 0 && (
          <div className="file-list-container no-print">
            <ul>
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="file-info">
                  <span title={file.name}>{file.name}</span>
                  <button onClick={() => handleRemoveFile(index)} disabled={loading} className="clear-file-button" aria-label={`Remove file ${file.name}`}>
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="response-container">
          <div className="response-area" aria-live="polite">
            <h2 className="print-only-title">{selectedPatient ? `Clinical Summary for ${selectedPatient.name}` : 'Clinical Summary'}</h2>
            {error && <div className="error-message">{error}</div>}
            {currentSummary ? (
              <div>
                <div className="summary-timestamp">
                    Summary from: {new Date(currentSummary.timestamp).toLocaleString()}
                </div>
                {currentSummary.summary['Key Changes'] && currentSummary.summary['Key Changes'].length > 0 && (
                    <div className="key-changes-section response-section">
                        <h3>Key Changes</h3>
                        <ul>
                            {currentSummary.summary['Key Changes'].map((item, index) => (
                                <li key={index}>{item}</li>
                            ))}
                        </ul>
                    </div>
                )}
                {Object.entries(currentSummary.summary).filter(([key]) => key !== 'Key Changes').map(([key, values]) => (
                  <div key={key} className={`response-section section-${toKebabCase(key)}`}>
                    <h3>{key}</h3>
                    <ul>
                      {Array.isArray(values) && values.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              !error && <p className="no-print">Select a patient or create a new one to see their summary.</p>
            )}
          </div>
          {(insightsLoading || insights) && (
            <div className="ai-insights-container">
                <h4>AI-Powered Insights</h4>
                {insightsLoading && <p className="no-print">Fetching insights...</p>}
                {insights && 
                  <div className="ai-insights-content">
                    {insights}
                  </div>
                }
            </div>
          )}
          {(referralLetterLoading || referralLetter) && (
            <div className="referral-letter-container" ref={referralContainerRef}>
                <h4>Draft Referral Letter to {referralSpecialty}</h4>
                {referralLetterLoading && <p className="no-print">Drafting letter...</p>}
                {referralLetter &&
                    <div className="referral-letter-content">
                        <pre className="referral-text">{referralLetter}</pre>
                        <button onClick={handleCopyReferral} className={`copy-button no-print ${referralCopied ? 'copied' : ''}`} disabled={referralCopied}>
                            {referralCopied ? 'Copied!' : 'Copy Letter'}
                        </button>
                    </div>
                }
            </div>
          )}
          {currentSummary && selectedPatient && (
             <div className="timeline-container no-print">
                <h4>Summary History</h4>
                <ul>
                    {selectedPatient.summaries.slice().reverse().map((summary, reversedIndex) => {
                        const originalIndex = selectedPatient.summaries.length - 1 - reversedIndex;
                        return (
                            <li 
                                key={summary.timestamp} 
                                className={originalIndex === viewingSummaryIndex ? 'active' : ''}
                                onClick={() => setViewingSummaryIndex(originalIndex)}
                            >
                               {new Date(summary.timestamp).toLocaleString()}
                            </li>
                        );
                    })}
                </ul>
            </div>
          )}
          {currentSummary && (
            <div className="response-actions no-print">
              <button onClick={handleGetAiInsights} disabled={insightsLoading} className="ai-button" aria-label="Get AI insights for the current summary">
                {insightsLoading ? 'Fetching insights...' : 'Get AI Insights'}
              </button>
               {!showReferralInput ? (
                <button onClick={() => setShowReferralInput(true)} disabled={referralLetterLoading} className="referral-button" aria-label="Draft a referral letter">
                  Draft Referral Letter
                </button>
              ) : (
                <div className="inline-form">
                  <input
                    type="text"
                    value={referralSpecialtyInput}
                    onChange={(e) => setReferralSpecialtyInput(e.target.value)}
                    placeholder="Enter specialty (e.g., Cardiology)"
                    aria-label="Referral specialty"
                    disabled={referralLetterLoading}
                  />
                  <button onClick={handleGenerateReferral} disabled={!referralSpecialtyInput.trim() || referralLetterLoading}>
                    {referralLetterLoading ? 'Drafting...' : 'Generate'}
                  </button>
                  <button onClick={() => { setShowReferralInput(false); setReferralSpecialtyInput(''); }} className="cancel-button" disabled={referralLetterLoading}>
                    Cancel
                  </button>
                </div>
              )}
              <button onClick={handleCopy} className={`copy-button ${copied ? 'copied' : ''}`} disabled={copied} aria-label="Copy response to clipboard">
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button onClick={handleExportPdf} className="export-button" disabled={isExportingPdf} aria-label="Export response to PDF">
                {isExportingPdf ? 'Exporting...' : 'Export to PDF'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);