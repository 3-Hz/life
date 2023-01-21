//-------GLOBALS-------
let gridsize;
let columns;
let rows;
let board;
let nextBoard;

//------P5.js LIFECYCLE HOOKS-------
// Initialize app parameters
function setup() {
    // initiate canvas
    frameRate(10);
    let renderer = createCanvas(window.innerWidth*3/4,window.innerHeight*3/4);
    renderer.parent("app");

    //initiate board
    gridsize = window.innerWidth > window.innerHeight ? floor(window.innerWidth/128) : floor(window.innerHeight/128);
    columns = floor(width/gridsize);
    rows = floor(height/gridsize);
    board = new Array(columns);
    nextBoard = new Array(columns);
    for (let i = 0; i < columns; i++) {
        board[i] = new Array(rows);
        nextBoard[i] = new Array(rows);
    }

    //spark life
    spark();
}

// Main event Loop
function draw() {
    doOneEpoch();
    renderBoard();
}

//-------EVENTS-------
// * Events affect the whole board by 
//   visiting each square via a traversal function
//   and then applying logic to that cell via a cell action

// Fills the board randomly
function spark() {
    traverseColxCol(chaos);
}

// Wrapper for spark for user trigger
function reSpark() {
    spark();
}

// Renders the board
function renderBoard() {
    traverseColxCol(renderSquare);
}

// Calculates the next generation
function doOneEpoch() {
    traverseColxCol(conway);
    let temp = board;
    board = nextBoard;
    nextBoard = temp;
}

//-------BOARD TRAVERSAL FUNCTIONS-------
// * Generically traverses the board and applies
//   a cell action to that cell

// Traverses down each column
function traverseColxCol(action) {
    for (let i = 0; i < columns; i++) {
        for (let j = 0; j < rows; j++) {
            action(i,j);
        }
    }
}

//-------CELL ACTIONS-------

//-------Rules of Life-------
// Randomly fills the cell, avoiding edges of the board. Also resets the state of the next board.
function chaos(i,j) {
    if (i == 0 || j == 0 || i == columns-1 || j == rows-1) board[i][j] = 0;
    else board[i][j] = floor(random(2));
    nextBoard[i][j]=0;
}

// Conway's Game of Life
function conway(i,j) {
    // Count this cell's neighbors
    let neighbors = countNeighbors(i,j);
    
    if ((board[i][j] == 1) && (neighbors < 2)) nextBoard[i][j] = 0;
    else if ((board[i][j] == 1) && (neighbors > 3)) nextBoard[i][j] = 0;
    else if ((board[i][j] == 0) && (neighbors == 3)) nextBoard[i][j] = 1;
    else nextBoard[i][j] = board[i][j];
}

//-------Helper Actions-------
// Renders a square
function renderSquare(i,j) {
    if (board[i][j] == 1) fill(0);
    else fill(255);
    stroke(255);
    rect(i*gridsize, j*gridsize, gridsize-1, gridsize-1);
}

// Counts neighbors
function countNeighbors(i,j) {
    let neighbors = 0;
    let nx;
    let ny;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            nx = i + dx;
            ny = j + dy;
            if ((nx > 0) && (nx < columns) && (ny > 0) && (ny < rows)) {
                neighbors += board[nx][ny];
            }
        }
    }
    neighbors -= board[i][j];
    return neighbors;
}