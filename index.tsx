/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import {GoogleGenAI, Part, Type} from '@google/genai';
import React, {useState, useMemo, useEffect, useRef} from 'react';
import ReactDOM from 'react-dom/client';
import { AUTH_PASSWORD } from './auth-config';

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
  dob: string;
  nhsNumber: string;
  summaries: SummaryRecord[];
}

// Define the structure for a differential diagnosis
interface DifferentialDiagnosis {
  diagnosis: string;
  rationale: string;
  likelihood: string;
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

const differentialDiagnosisSchema = {
    type: Type.OBJECT,
    properties: {
        diagnoses: {
            type: Type.ARRAY,
            description: "A list of potential differential diagnoses.",
            items: {
                type: Type.OBJECT,
                properties: {
                    diagnosis: {
                        type: Type.STRING,
                        description: "The name of the potential medical condition."
                    },
                    rationale: {
                        type: Type.STRING,
                        description: "A concise rationale for why this diagnosis is being considered, citing evidence from the patient summary."
                    },
                    likelihood: {
                        type: Type.STRING,
                        description: "The estimated likelihood of this diagnosis (e.g., 'High', 'Medium', 'Low')."
                    }
                },
                required: ["diagnosis", "rationale", "likelihood"]
            }
        }
    },
    required: ["diagnoses"]
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

function LoginModal({ onAuthenticate }: { onAuthenticate: () => void }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passwordInputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (!password) return;
    
    if (password === AUTH_PASSWORD) {
      setIsClosing(true);
      setTimeout(() => {
        sessionStorage.setItem('hx_auth', 'true');
        onAuthenticate();
      }, 400);
    } else {
      setError(true);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && password) {
      handleSubmit();
    }
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (error) setError(false);
  };

  return (
    <div className={`auth-overlay ${isClosing ? 'closing' : ''}`}>
      <div className="auth-modal">
        <div className="auth-lock-icon">🔒</div>
        <h2 className="auth-title">Authentication Required</h2>
        <p className="auth-subtitle">AI Clinical Summariser</p>
        
        <div className="auth-input-group">
          <label htmlFor="password-input" className="auth-label">Password</label>
          <div className="password-input-wrapper">
            <input
              ref={passwordInputRef}
              id="password-input"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={handlePasswordChange}
              onKeyPress={handleKeyPress}
              placeholder="Enter password"
              className="auth-input"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="password-toggle-btn"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? '👁️' : '👁️‍🗨️'}
            </button>
          </div>
          {error && <span className="auth-error">Incorrect password. Please try again.</span>}
        </div>
        
        <button onClick={handleSubmit} className="auth-submit-btn" disabled={!password}>
          Unlock
        </button>
      </div>
    </div>
  );
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

  // Differential Diagnosis state
  const [differentialDiagnosis, setDifferentialDiagnosis] = useState<DifferentialDiagnosis[] | null>(null);
  const [differentialDiagnosisLoading, setDifferentialDiagnosisLoading] = useState(false);

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
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Patient Edit Modal State
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingPatientDetails, setEditingPatientDetails] = useState<Omit<Patient, 'summaries'> | null>(null);

  // Authentication State
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return sessionStorage.getItem('hx_auth') === 'true';
  });

  // GDPR & Privacy State
  const [showGdprBanner, setShowGdprBanner] = useState(false);
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState(false);

  // Check for SpeechRecognition API
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const isSpeechRecognitionSupported = !!SpeechRecognition;
  
  // Effect to save patients to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('patientData', JSON.stringify(patients));
  }, [patients]);

  // Effect to check for GDPR acknowledgment
  useEffect(() => {
    const isAcknowledged = localStorage.getItem('gdpr_acknowledged');
    if (!isAcknowledged) {
      setShowGdprBanner(true);
    }
  }, []);
  
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
    setDifferentialDiagnosis(null);
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
    setDifferentialDiagnosis(null);

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

Crucially, within the "Pending Tasks and action Plan" section, you must explicitly document a detailed treatment plan for the new acute concerns, formatted clearly for inclusion in an Electronic Health Record (EHR). This plan must be actionable and follow standard UK clinical practice (NICE/CKS guidelines).

The plan for the new concerns should include specific management instructions (e.g., "Started on Amoxicillin 500mg three times daily," "Prescribed Lactulose 10ml twice daily"). Also, generate a long-term management plan and identify key changes from the previous summary.

PREVIOUS SUMMARY:
${JSON.stringify(latestExistingSummary.summary)}

NEW ACUTE CONCERNS:
${prompt}`;
        schemaForRequest = updateSummaryResponseSchema;
      } else {
        finalPrompt = `Act as a clinical assistant responsible for patient records. Create a concise, structured clinical summary from the information provided. For any acute issues identified, you must explicitly document a detailed treatment plan within the "Pending Tasks and action Plan" section. This plan must be formatted clearly for inclusion in an Electronic Health Record (EHR), be actionable, and follow standard UK clinical practice (NICE/CKS guidelines).

The plan should include specific management instructions (e.g., "Started on Amoxicillin 500mg three times daily," "Prescribed Lactulose 10ml twice daily") and a suggested long-term management plan.

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

      // --- Programmatically handle safety netting advice ---
      const SAFETY_NETTING_ADVICE = "If symptoms worsen, or if new symptoms develop, please seek urgent medical advice by calling 111, your GP surgery, or 999 in an emergency.";

      // Ensure the 'Pending Tasks and action Plan' exists and is an array
      if (!newSummaryData['Pending Tasks and action Plan'] || !Array.isArray(newSummaryData['Pending Tasks and action Plan'])) {
        newSummaryData['Pending Tasks and action Plan'] = [];
      }
      // Filter out any existing/similar safety netting advice to prevent duplicates
      newSummaryData['Pending Tasks and action Plan'] = newSummaryData['Pending Tasks and action Plan'].filter(
          item => !item.toLowerCase().includes('symptoms worsen') && !item.toLowerCase().includes('999')
      );
      // Add the standardized advice to the end of the plan
      newSummaryData['Pending Tasks and action Plan'].push(SAFETY_NETTING_ADVICE);
      // --- End of safety netting logic ---

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
          dob: '',
          nhsNumber: '',
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
        const referralPrompt = `You are an assistant for a UK clinician. Draft an extremely concise, to-the-point, UK-style referral letter to a ${referralSpecialtyInput.trim()} specialist for the patient.

The entire letter must be a maximum of 3-4 lines. It should only contain the most critical information for the specialist. Use placeholders like [Patient Name] and [NHS Number] for demographic details.

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

  const handleSuggestDifferentials = async () => {
    if (!currentSummary) return;

    setDifferentialDiagnosisLoading(true);
    setDifferentialDiagnosis(null);
    setError(null);

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const diffPrompt = `Act as an expert clinical reasoning assistant for a UK clinician. Based on the provided clinical summary, generate a list of potential differential diagnoses.

For each diagnosis, provide a concise rationale citing specific evidence from the summary. Also, provide an estimated likelihood (High, Medium, or Low). Order the list from most to least likely.

---
**PATIENT SUMMARY:**
${JSON.stringify(currentSummary.summary, null, 2)}`;
        
        const result = await ai.models.generateContent({
            model: 'gemini-2.5-pro', // Using a more advanced model for complex reasoning
            contents: { parts: [{ text: diffPrompt }] },
            config: {
                responseMimeType: 'application/json',
                responseSchema: differentialDiagnosisSchema,
            },
        });
        
        const jsonText = result.text.trim();
        const responseData = JSON.parse(jsonText);
        setDifferentialDiagnosis(responseData.diagnoses);

    } catch (err) {
        console.error("Error generating differential diagnosis:", err);
        setError("Could not generate differential diagnosis at this time.");
    } finally {
        setDifferentialDiagnosisLoading(false);
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
      setError("PDF export library not available. Please try again later.");
      return;
    }
    if (!currentSummary || !selectedPatient) {
      alert("No summary to export.");
      return;
    }
  
    setIsExportingPdf(true);
    setError(null);
  
    const escapeHtml = (unsafe: string | undefined | null) =>
      (unsafe || '')
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
  
    let contentHtml = `
      <div class="pdf-document">
        <div class="report-header">
          <h1>Clinical Summary Report</h1>
          <h2>${escapeHtml(selectedPatient.name)}</h2>
          <p>DOB: ${escapeHtml(selectedPatient.dob || 'N/A')} | NHS Number: ${escapeHtml(selectedPatient.nhsNumber || 'N/A')}</p>
          <p><em>Report Generated: ${new Date().toLocaleString()} | Summary Date: ${new Date(currentSummary.timestamp).toLocaleString()}</em></p>
        </div>
    `;
  
    const { summary } = currentSummary;
    const sectionsOrder: (keyof StructuredResponse)[] = ['Key Changes', 'Acute Issues', 'Pending Tasks and action Plan', 'Past medical history'];
  
    sectionsOrder.forEach(key => {
        const sectionData = summary[key];
        if (sectionData && Array.isArray(sectionData) && sectionData.length > 0) {
            contentHtml += `<div class="section">`;
            contentHtml += `<h3 class="section-title">${escapeHtml(key)}</h3>`;
            contentHtml += '<ul class="summary-list">';
            sectionData.forEach((item: string) => {
                contentHtml += `<li>${escapeHtml(item)}</li>`;
            });
            contentHtml += '</ul></div>';
        }
    });
  
    if (insights) {
      contentHtml += `<div class="page-break"></div><div class="section"><h3 class="section-title">AI-Powered Insights</h3><div class="ai-content-box">${escapeHtml(insights).replace(/\n/g, '<br>')}</div></div>`;
    }

    if (differentialDiagnosis && differentialDiagnosis.length > 0) {
        contentHtml += `<div class="page-break"></div><div class="section"><h3 class="section-title">Differential Diagnosis Assistant</h3>`;
        contentHtml += '<ul class="differential-list">';
        differentialDiagnosis.forEach(item => {
            contentHtml += `<li class="differential-item"><strong>${escapeHtml(item.diagnosis)}</strong><span class="likelihood">Likelihood: ${escapeHtml(item.likelihood)}</span><p>${escapeHtml(item.rationale)}</p></li>`;
        });
        contentHtml += '</ul></div>';
    }
  
    if (referralLetter) {
      const specialty = referralSpecialty || 'Specialist';
      contentHtml += `<div class="page-break"></div><div class="section"><h3 class="section-title">Draft Referral Letter to ${escapeHtml(specialty)}</h3><div class="ai-content-box">${escapeHtml(referralLetter).replace(/\n/g, '<br>')}</div></div>`;
    }
  
    contentHtml += `</div>`;
  
    const styles = `
      /* General Document Styles */
      .pdf-document { font-family: 'Times New Roman', Times, serif; color: #000; font-size: 12pt; line-height: 1.5; }
      /* Header Section */
      .report-header { text-align: center; margin-bottom: 0.5in; border-bottom: 2px solid #000; padding-bottom: 0.2in; }
      .report-header h1 { font-size: 18pt; margin: 0 0 10px 0; font-weight: bold; }
      .report-header h2 { font-size: 16pt; margin: 0; font-weight: bold; }
      .report-header p { font-size: 11pt; color: #333; margin: 5px 0 0 0; }
      .report-header p em { font-size: 10pt; color: #555;}
      /* Section Styling */
      .section { margin-bottom: 0.3in; }
      .section-title { font-size: 14pt; font-weight: bold; margin: 0 0 0.2in 0; padding-bottom: 5px; border-bottom: 1px solid #ccc; }
      .page-break { page-break-before: always; }
      .page-break + .section .section-title { margin-top: 0; }
      /* List Styling for Summary */
      .summary-list { list-style-type: disc; padding-left: 0.3in; margin: 0; }
      .summary-list li { margin-bottom: 8px; padding-left: 5px; }
      /* AI Content Styling (Insights, Referral) */
      .ai-content-box { white-space: pre-wrap; word-wrap: break-word; font-family: 'Times New Roman', Times, serif; padding: 0.15in; border: 1px solid #e0e0e0; background-color: #f9f9f9; border-radius: 4px; }
      /* Differential Diagnosis List Styling */
      .differential-list { list-style-type: none; padding-left: 0; margin: 0; }
      .differential-item { margin-bottom: 0.25in; padding: 0.2in; border: 1px solid #e5e5e5; border-radius: 4px; background-color: #fafafa; }
      .differential-item:last-child { margin-bottom: 0; }
      .differential-item strong { display: block; font-size: 13pt; font-weight: bold; margin-bottom: 5px; }
      .likelihood { font-size: 11pt; color: #444; font-style: italic; margin-bottom: 8px; display: block; }
      .differential-item p { margin: 0; font-style: normal; color: #222; }
    `;

    const fullHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>${escapeHtml(selectedPatient.name)} Clinical Summary</title>
          <style>${styles}</style>
        </head>
        <body>
          ${contentHtml}
        </body>
      </html>
    `;
  
    const patientName = selectedPatient.name.replace(/\s+/g, '_');
    const filename = `${patientName}_Clinical_Summary_${new Date().toISOString().split('T')[0]}.pdf`;
  
    const options = {
      margin: 0.75,
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, letterRendering: true },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    };
  
    (window as any).html2pdf().from(fullHtml).set(options).save()
      .catch((err: Error) => {
        console.error("PDF generation failed:", err);
        setError("Sorry, there was an error exporting the PDF.");
      })
      .finally(() => {
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

  const handleOpenEditModal = (patient: Patient) => {
    setEditingPatientDetails({
        id: patient.id,
        name: patient.name,
        dob: patient.dob || '',
        nhsNumber: patient.nhsNumber || '',
    });
    setIsEditModalOpen(true);
  };

  const handleCloseEditModal = () => {
    setIsEditModalOpen(false);
    setEditingPatientDetails(null);
  };

  const handleSavePatientDetails = () => {
    if (!editingPatientDetails) return;
    setPatients(prev => 
        prev.map(p => 
            p.id === editingPatientDetails.id 
                ? { ...p, ...editingPatientDetails } 
                : p
        )
    );
    handleCloseEditModal();
  };

  const handleAcknowledgeGdpr = () => {
    localStorage.setItem('gdpr_acknowledged', 'true');
    setShowGdprBanner(false);
  };

  const handleClearAllData = () => {
    if (window.confirm("Are you sure you want to permanently delete ALL patient data from this browser? This action cannot be undone.")) {
      localStorage.removeItem('patientData');
      setPatients([]);
      setSelectedPatientId(null);
      // Optional: also clear the GDPR acknowledgement if you want it to reappear for a fresh start
      // localStorage.removeItem('gdpr_acknowledged');
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('hx_auth');
    setIsAuthenticated(false);
  };
  
  const filteredPatients = patients.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const renderSummary = () => {
    if (!currentSummary) {
      return !error && <p className="placeholder-text">Select a patient or create a new one to see their summary.</p>;
    }
    const { summary } = currentSummary;
    const sectionsOrder: (keyof StructuredResponse)[] = ['Key Changes', 'Acute Issues', 'Pending Tasks and action Plan', 'Past medical history'];
    
    return (
      <>
        {sectionsOrder.map(key => {
          const values = summary[key];
          if (values && Array.isArray(values) && values.length > 0) {
            return (
              <div key={key} className={`response-section section-${toKebabCase(key)}`}>
                <h3>{key}</h3>
                <ul>
                  {values.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            );
          }
          return null;
        })}
      </>
    );
  };

  const renderAssistantPanel = () => (
    <>
      {(insightsLoading || insights) && (
        <div className="assistant-card" id="ai-insights-container">
            <h4>AI-Powered Insights</h4>
            {insightsLoading && <div className="loader">Fetching insights...</div>}
            {insights && <div className="ai-insights-content">{insights}</div>}
        </div>
      )}
      {(differentialDiagnosisLoading || differentialDiagnosis) && (
        <div className="assistant-card" id="differential-diagnosis-container">
          <h4>Differential Diagnosis Assistant</h4>
          {differentialDiagnosisLoading && <div className="loader">Analyzing summary...</div>}
          {differentialDiagnosis && (
            <ul className="differential-diagnosis-list">
              {differentialDiagnosis.map((item, index) => (
                <li key={index}>
                  <strong>{item.diagnosis}</strong> (Likelihood: {item.likelihood})
                  <p>{item.rationale}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {(referralLetterLoading || referralLetter) && (
        <div className="assistant-card" id="referral-letter-container" ref={referralContainerRef}>
            <h4>Draft Referral Letter to {referralSpecialty}</h4>
            {referralLetterLoading && <div className="loader">Drafting letter...</div>}
            {referralLetter && (
              <div className="referral-letter-content">
                  <pre className="referral-text">{referralLetter}</pre>
                  <button onClick={handleCopyReferral} className={`copy-button ${referralCopied ? 'copied' : ''}`} disabled={referralCopied}>
                      {referralCopied ? 'Copied!' : 'Copy Letter'}
                  </button>
              </div>
            )}
        </div>
      )}
    </>
  );

  const renderEditPatientModal = () => {
    if (!isEditModalOpen || !editingPatientDetails) return null;
  
    return (
      <div className="modal-overlay" onClick={handleCloseEditModal}>
        <div className="modal-content" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Edit Patient Details</h3>
            <button onClick={handleCloseEditModal} className="close-modal-btn">&times;</button>
          </div>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="patient-name">Name</label>
              <input
                id="patient-name"
                type="text"
                value={editingPatientDetails.name}
                onChange={e => setEditingPatientDetails({ ...editingPatientDetails, name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="patient-dob">Date of Birth</label>
              <input
                id="patient-dob"
                type="date"
                value={editingPatientDetails.dob}
                onChange={e => setEditingPatientDetails({ ...editingPatientDetails, dob: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="patient-nhs">NHS Number</label>
              <input
                id="patient-nhs"
                type="text"
                value={editingPatientDetails.nhsNumber}
                onChange={e => setEditingPatientDetails({ ...editingPatientDetails, nhsNumber: e.target.value })}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button onClick={handleCloseEditModal} className="cancel-button">Cancel</button>
            <button onClick={handleSavePatientDetails}>Save Changes</button>
          </div>
        </div>
      </div>
    );
  };

  const renderPrivacyModal = () => {
    if (!isPrivacyModalOpen) return null;
  
    return (
      <div className="modal-overlay" onClick={() => setIsPrivacyModalOpen(false)}>
        <div className="modal-content" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Privacy & Data Information</h3>
            <button onClick={() => setIsPrivacyModalOpen(false)} className="close-modal-btn">&times;</button>
          </div>
          <div className="modal-body privacy-modal-body">
            <h4>Data Storage</h4>
            <p>All patient information you enter (including names, dates of birth, NHS numbers, and clinical notes) is stored <strong>exclusively in your browser's local storage</strong>. This data never leaves your computer and is not sent to our servers.</p>
            
            <h4>Data Security</h4>
            <p>You are responsible for ensuring the physical and digital security of the device you are using. The data stored in your browser is not encrypted by this application.</p>
            
            <h4>Your Rights & Data Control</h4>
            <p>You have full control over your data. You can view, edit, and delete individual patient records at any time. To permanently erase all data from this browser, use the <strong>"Clear All Patient Data"</strong> button at the bottom of the patient list.</p>

            <h4>Third-Party Services (Google Gemini API)</h4>
            <p>This application uses the Google Gemini API to generate summaries and insights. When you use an AI feature, only the relevant clinical text from the summary is sent to Google for processing. Patient demographic data (Name, DOB, NHS Number) is <strong>not</strong> sent to the API. For more information, please refer to Google's privacy policy.</p>
          </div>
          <div className="modal-footer">
            <button onClick={() => setIsPrivacyModalOpen(false)}>Close</button>
          </div>
        </div>
      </div>
    );
  };
  
  return (
    <>
      {renderEditPatientModal()}
      {renderPrivacyModal()}
      <div className={`app-layout ${!isSidebarOpen ? 'sidebar-collapsed' : ''}`}>
        <div className="sidebar">
          <div className="sidebar-header">
              <h2>Patient Records</h2>
          </div>
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
          <div className="sidebar-footer">
            <button onClick={handleCreateNew} className="new-patient-btn">
                + New Patient Summary
            </button>
            <div className="privacy-actions">
              <button onClick={() => setIsPrivacyModalOpen(true)} className="privacy-btn">Privacy & Data</button>
              <button onClick={handleClearAllData} className="clear-data-btn">Clear All Patient Data</button>
            </div>
          </div>
        </div>
        <div className="content-wrapper">
          <div className="content-overlay" onClick={() => setIsSidebarOpen(false)}></div>
          <header className="app-header">
            <button className="sidebar-toggle" onClick={() => setIsSidebarOpen(!isSidebarOpen)} aria-label="Toggle patient records sidebar">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
            </button>
            <h1>AI Clinical Summariser</h1>
            <p>Generate, update, and manage patient notes with AI-powered efficiency.</p>
            {isAuthenticated && (
              <button 
                onClick={handleLogout} 
                className="logout-btn"
                aria-label="Logout"
                title="Logout"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                  <polyline points="16 17 21 12 16 7"></polyline>
                  <line x1="21" y1="12" x2="9" y2="12"></line>
                </svg>
              </button>
            )}
          </header>
          <main className="main-grid">
            <div className="main-content-stack">
              <div className="column summary-column">
                  {selectedPatient && (
                      <div className="card patient-details-card">
                          <div className="card-header">
                              <h3>Patient Details</h3>
                              <button className="edit-details-btn" onClick={() => handleOpenEditModal(selectedPatient)}>Edit</button>
                          </div>
                          <div className="card-content">
                              <div className="detail-item"><strong>Name:</strong> {selectedPatient.name}</div>
                              <div className="detail-item"><strong>DOB:</strong> {selectedPatient.dob || 'Not set'}</div>
                              <div className="detail-item"><strong>NHS Number:</strong> {selectedPatient.nhsNumber || 'Not set'}</div>
                          </div>
                      </div>
                  )}
                <div className="card summary-history-card">
                  <div className="card-header">
                    <h3>Clinical Summary</h3>
                    {currentSummary && (
                       <div className="summary-timestamp">
                          {new Date(currentSummary.timestamp).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className="card-content response-area">
                    {error && <div className="error-message">{error}</div>}
                    {renderSummary()}
                  </div>
                  {currentSummary && selectedPatient && (
                     <div className="timeline-container">
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
                </div>
              </div>

              <div className="column actions-column">
                <div className="card">
                  <div className="card-header">
                    <h3>Actions & Inputs</h3>
                  </div>
                  <div className="card-content">
                    <form onSubmit={handleSubmit}>
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
                          <textarea
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="Enter acute concerns (e.g., new confusion, new cough)..."
                            disabled={loading}
                            aria-label="Acute concerns input"
                            rows={3}
                          />
                          {isSpeechRecognitionSupported && (
                            <button
                              type="button"
                              onClick={handleToggleListening}
                              className={`mic-button ${isListening ? 'listening' : ''}`}
                              disabled={loading}
                              aria-label={isListening ? 'Stop dictation' : 'Start dictation'}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="form-row file-upload-row">
                        <label htmlFor="file-upload" className="file-upload-button" aria-disabled={loading}>
                          Upload Document(s)
                        </label>
                        <input id="file-upload" type="file" onChange={handleFileChange} disabled={loading} multiple />
                        <button type="submit" disabled={loading || (!prompt.trim() && files.length === 0)}>
                          {loading ? (selectedPatient ? 'Updating...' : 'Generating...') : (selectedPatient ? 'Update Summary' : 'Submit')}
                        </button>
                      </div>
                    </form>
                    {files.length > 0 && (
                      <div className="file-list-container">
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

                    {currentSummary && (
                      <div className="response-actions">
                        <button onClick={handleGetAiInsights} disabled={insightsLoading} className="action-button ai-button" aria-label="Get AI insights for the current summary">
                          {insightsLoading ? 'Fetching insights...' : 'Get AI Insights'}
                        </button>
                        <button onClick={handleSuggestDifferentials} disabled={differentialDiagnosisLoading} className="action-button diff-dx-button" aria-label="Suggest differential diagnoses">
                          {differentialDiagnosisLoading ? 'Analyzing...' : 'Suggest Differentials'}
                        </button>
                        {!showReferralInput ? (
                          <button onClick={() => setShowReferralInput(true)} disabled={referralLetterLoading} className="action-button referral-button" aria-label="Draft a referral letter">
                            Draft Referral Letter
                          </button>
                        ) : (
                          <div className="inline-form">
                            <input
                              type="text"
                              value={referralSpecialtyInput}
                              onChange={(e) => setReferralSpecialtyInput(e.target.value)}
                              placeholder="Enter specialty..."
                              aria-label="Referral specialty"
                              disabled={referralLetterLoading}
                            />
                            <div className="inline-form-buttons">
                              <button onClick={handleGenerateReferral} disabled={!referralSpecialtyInput.trim() || referralLetterLoading}>
                                {referralLetterLoading ? '...' : 'Go'}
                              </button>
                              <button onClick={() => { setShowReferralInput(false); setReferralSpecialtyInput(''); }} className="cancel-button" disabled={referralLetterLoading}>
                                &times;
                              </button>
                            </div>
                          </div>
                        )}
                        <hr className="divider" />
                        <button onClick={handleCopy} className={`action-button copy-button ${copied ? 'copied' : ''}`} disabled={copied} aria-label="Copy response to clipboard">
                          {copied ? 'Copied!' : 'Copy Summary'}
                        </button>
                        <button onClick={handleExportPdf} className="action-button export-button" disabled={isExportingPdf} aria-label="Export response to PDF">
                          {isExportingPdf ? 'Exporting...' : 'Export to PDF'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            
            <div className="column assistant-column">
              <div className="card">
                <div className="card-header">
                   <h3>AI Assistant</h3>
                </div>
                <div className="card-content assistant-panel">
                  {renderAssistantPanel()}
                  {!insights && !differentialDiagnosis && !referralLetter &&
                    <p className="placeholder-text">AI-generated content will appear here.</p>
                  }
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
      {showGdprBanner && (
        <div className="gdpr-banner">
          <p>This app stores patient data in your browser's local storage. No data is sent to our servers. You are responsible for securing your device. <button onClick={() => setIsPrivacyModalOpen(true)} className="link-button">Learn More</button></p>
          <button onClick={handleAcknowledgeGdpr}>Acknowledge</button>
        </div>
      )}
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);