/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import {GoogleGenAI, Part, Type} from '@google/genai';
import React, {useState, useMemo, useEffect} from 'react';
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
    description: 'List of pending tasks and the plan of action.'
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

const ExpandableContent = ({ content, maxLength }: { content: string; maxLength: number }) => {
    const [isExpanded, setIsExpanded] = useState(false);

    if (!content || content.length <= maxLength) {
        return <>{content}</>;
    }

    return (
        <>
            {isExpanded ? content : `${content.substring(0, maxLength)}...`}
            <button onClick={() => setIsExpanded(!isExpanded)} className="expand-toggle-btn">
                {isExpanded ? 'Show Less' : 'Read More'}
            </button>
        </>
    );
};


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
  
  // Effect to save patients to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('patientData', JSON.stringify(patients));
  }, [patients]);

  const selectedPatient = useMemo(() => {
    return patients.find(p => p.id === selectedPatientId) || null;
  }, [patients, selectedPatientId]);

  const currentSummary = useMemo(() => {
    if (!selectedPatient || !selectedPatient.summaries[viewingSummaryIndex]) {
        return null;
    }
    return selectedPatient.summaries[viewingSummaryIndex];
  }, [selectedPatient, viewingSummaryIndex]);

  // Clear insights when the viewed summary changes
  useEffect(() => {
    setInsights(null);
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

      let finalPrompt = prompt;
      let schemaForRequest = newSummaryResponseSchema;
      const patientToUpdate = selectedPatient;
      const latestExistingSummary = patientToUpdate?.summaries[0];

      if (patientToUpdate && latestExistingSummary) {
        finalPrompt = `Based on the following new information, please provide an updated summary. Also, identify the key changes compared to the previous summary provided below.\n\nPREVIOUS SUMMARY:\n${JSON.stringify(latestExistingSummary.summary)}\n\nNEW INFORMATION/PROMPT:\n${prompt}`;
        schemaForRequest = updateSummaryResponseSchema;
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
        const insightsPrompt = `Based on the following clinical summary, provide actionable insights. Include sections for "Potential Next Steps", "Key Risks to Monitor", and "Suggested Patient Questions". Format the output clearly.\n\nSUMMARY:\n${JSON.stringify(currentSummary.summary, null, 2)}`;
        
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
            <h1>{selectedPatient ? `Updating: ${selectedPatient.name}` : 'New Patient Summary'}</h1>
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
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Enter your prompt..."
              disabled={loading}
              aria-label="Prompt input"
            />
            <button type="submit" disabled={loading || (!prompt.trim() && files.length === 0)}>
              {loading ? 'Loading...' : (selectedPatient ? 'Update Summary' : 'Submit')}
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
              !error && <p>Select a patient or create a new one to see their summary.</p>
            )}
          </div>
          {(insightsLoading || insights) && (
            <div className="ai-insights-container no-print">
                <h4>AI-Powered Insights</h4>
                {insightsLoading && <p>Generating suggestions...</p>}
                {insights && 
                  <div className="ai-insights-content">
                    <ExpandableContent content={insights} maxLength={400} />
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
                {insightsLoading ? 'Thinking...' : 'Get AI Insights'}
              </button>
              <button onClick={handleCopy} className={`copy-button ${copied ? 'copied' : ''}`} disabled={copied} aria-label="Copy response to clipboard">
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button onClick={() => window.print()} className="export-button" aria-label="Export response to PDF">
                Export to PDF
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