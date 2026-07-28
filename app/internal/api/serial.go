package api

// SerialPortInfo mirrors SerialPortInfo: one serial device reported by the
// host OS. Optional fields use omitempty because the Node server serializes
// missing values as absent keys (undefined is dropped by JSON.stringify).
type SerialPortInfo struct {
	// Path is the OS-native path (COM3, /dev/ttyUSB0, /dev/tty.usbserial-…).
	Path         string `json:"path"`
	Manufacturer string `json:"manufacturer,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	PnpID        string `json:"pnpId,omitempty"`
	LocationID   string `json:"locationId,omitempty"`
	ProductID    string `json:"productId,omitempty"`
	VendorID     string `json:"vendorId,omitempty"`
}

// SerialPortsResponse mirrors SerialPortsResponse.
type SerialPortsResponse struct {
	Ports []SerialPortInfo `json:"ports"`
}
